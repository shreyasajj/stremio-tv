#include "mpvcontroller.h"
#include <QByteArray>
#include <QDebug>
#include <QMetaObject>
#include <vector>

namespace {

// Properties pushed to the web UI as they change.
const char *const kObserved[] = {
    "pause", "time-pos", "duration", "demuxer-cache-time", "paused-for-cache",
    "seeking", "eof-reached", "speed", "track-list", "audio-codec-name",
    "audio-out-params", "current-ao", "idle-active",
};
// High-frequency properties: forwarded at most every 250 ms.
const QSet<QString> kThrottled = { "time-pos", "demuxer-cache-time" };

void wakeup(void *ctx) {
    auto *core = static_cast<MpvCore *>(ctx);
    std::lock_guard<std::mutex> lock(core->mutex);
    if (core->controller)
        QMetaObject::invokeMethod(core->controller, "processEvents", Qt::QueuedConnection);
}

QString endReason(mpv_end_file_reason reason) {
    switch (reason) {
    case MPV_END_FILE_REASON_EOF: return QStringLiteral("eof");
    case MPV_END_FILE_REASON_STOP: return QStringLiteral("stop");
    case MPV_END_FILE_REASON_QUIT: return QStringLiteral("quit");
    case MPV_END_FILE_REASON_ERROR: return QStringLiteral("error");
    case MPV_END_FILE_REASON_REDIRECT: return QStringLiteral("redirect");
    }
    return QStringLiteral("unknown");
}

} // namespace

QVariant mpvNodeToVariant(const mpv_node *node) {
    switch (node->format) {
    case MPV_FORMAT_STRING:
    case MPV_FORMAT_OSD_STRING:
        return QString::fromUtf8(node->u.string);
    case MPV_FORMAT_FLAG:
        return bool(node->u.flag);
    case MPV_FORMAT_INT64:
        return QVariant::fromValue<qlonglong>(node->u.int64);
    case MPV_FORMAT_DOUBLE:
        return node->u.double_;
    case MPV_FORMAT_NODE_ARRAY: {
        QVariantList list;
        for (int i = 0; i < node->u.list->num; ++i)
            list << mpvNodeToVariant(&node->u.list->values[i]);
        return list;
    }
    case MPV_FORMAT_NODE_MAP: {
        QVariantMap map;
        for (int i = 0; i < node->u.list->num; ++i)
            map.insert(QString::fromUtf8(node->u.list->keys[i]),
                       mpvNodeToVariant(&node->u.list->values[i]));
        return map;
    }
    default:
        return {};
    }
}

MpvCore::~MpvCore() {
    if (handle) mpv_terminate_destroy(handle);
}

MpvController::MpvController(QObject *parent) : QObject(parent), core_(std::make_shared<MpvCore>()) {
    mpv_handle *h = mpv_create();
    if (!h) {
        qWarning() << "mpv_create failed";
        return;
    }
    mpv_set_option_string(h, "vo", "libmpv");
    mpv_set_option_string(h, "hwdec", "auto-safe");
    mpv_set_option_string(h, "idle", "yes");
    mpv_set_option_string(h, "keep-open", "no");
    mpv_set_option_string(h, "ytdl", "no");
    mpv_set_option_string(h, "input-default-bindings", "no");
    mpv_set_option_string(h, "input-vo-keyboard", "no");
    mpv_set_option_string(h, "osd-level", "0");
    // Network streams: a generous forward buffer smooths debrid/HTTP playback.
    mpv_set_option_string(h, "cache", "yes");
    mpv_set_option_string(h, "demuxer-max-bytes", "300MiB");
    mpv_set_option_string(h, "demuxer-max-back-bytes", "64MiB");
    mpv_set_option_string(h, "network-timeout", "30");
    mpv_set_option_string(h, "sub-auto", "no");
    mpv_set_option_string(h, "audio-display", "no");
    mpv_set_option_string(h, "terminal", "no");
    mpv_set_option_string(h, "msg-level", "all=warn");
    if (mpv_initialize(h) < 0) {
        qWarning() << "mpv_initialize failed";
        mpv_terminate_destroy(h);
        return;
    }
    mpv_request_log_messages(h, "warn");
    for (const char *name : kObserved)
        mpv_observe_property(h, 0, name, MPV_FORMAT_NODE);

    core_->handle = h;
    core_->controller = this;
    mpv_set_wakeup_callback(h, wakeup, core_.get());

    throttleTimer_.setInterval(250);
    connect(&throttleTimer_, &QTimer::timeout, this, &MpvController::flushThrottled);
    throttleTimer_.start();
}

MpvController::~MpvController() {
    if (!core_->handle) return;
    mpv_set_wakeup_callback(core_->handle, nullptr, nullptr);
    std::lock_guard<std::mutex> lock(core_->mutex);
    core_->controller = nullptr;
    // Stop now rather than whenever the render thread drops the last ref.
    const char *args[] = { "stop", nullptr };
    mpv_command(core_->handle, args);
}

void MpvController::command(const QStringList &args) {
    if (!available() || args.isEmpty()) return;
    std::vector<QByteArray> storage;
    storage.reserve(args.size());
    std::vector<const char *> argv;
    for (const QString &a : args) {
        storage.push_back(a.toUtf8());
        argv.push_back(storage.back().constData());
    }
    argv.push_back(nullptr);
    mpv_command_async(core_->handle, 0, argv.data());
}

void MpvController::setOption(const QString &name, const QVariant &value) {
    if (!available()) return;
    const QByteArray key = name.toUtf8();
    switch (value.typeId()) {
    case QMetaType::Bool: {
        int flag = value.toBool() ? 1 : 0;
        mpv_set_property_async(core_->handle, 0, key.constData(), MPV_FORMAT_FLAG, &flag);
        break;
    }
    case QMetaType::Int:
    case QMetaType::LongLong: {
        int64_t n = value.toLongLong();
        mpv_set_property_async(core_->handle, 0, key.constData(), MPV_FORMAT_INT64, &n);
        break;
    }
    case QMetaType::Double: {
        double d = value.toDouble();
        mpv_set_property_async(core_->handle, 0, key.constData(), MPV_FORMAT_DOUBLE, &d);
        break;
    }
    default: {
        const QByteArray s = value.toString().toUtf8();
        const char *str = s.constData();
        mpv_set_property_async(core_->handle, 0, key.constData(), MPV_FORMAT_STRING, &str);
    }
    }
}

QVariant MpvController::getProperty(const QString &name) const {
    if (!available()) return {};
    mpv_node node;
    if (mpv_get_property(core_->handle, name.toUtf8().constData(), MPV_FORMAT_NODE, &node) < 0)
        return {};
    QVariant v = mpvNodeToVariant(&node);
    mpv_free_node_contents(&node);
    return v;
}

void MpvController::handlePropertyChange(const QString &name, const QVariant &value) {
    if (kThrottled.contains(name)) {
        throttled_.insert(name, value);
        return;
    }
    // A seek or pause should be reflected with an up-to-date position.
    if (name == QLatin1String("seeking") || name == QLatin1String("pause")) flushThrottled();
    emit propertyChanged(name, value);
}

void MpvController::flushThrottled() {
    if (throttled_.isEmpty()) return;
    const auto pending = std::exchange(throttled_, {});
    for (auto it = pending.cbegin(); it != pending.cend(); ++it)
        emit propertyChanged(it.key(), it.value());
}

void MpvController::processEvents() {
    if (!available()) return;
    while (true) {
        mpv_event *event = mpv_wait_event(core_->handle, 0);
        if (event->event_id == MPV_EVENT_NONE) break;
        switch (event->event_id) {
        case MPV_EVENT_PROPERTY_CHANGE: {
            auto *prop = static_cast<mpv_event_property *>(event->data);
            QVariant value;
            if (prop->format == MPV_FORMAT_NODE) value = mpvNodeToVariant(static_cast<mpv_node *>(prop->data));
            handlePropertyChange(QString::fromUtf8(prop->name), value);
            break;
        }
        case MPV_EVENT_FILE_LOADED:
            // Make sure the UI sees the duration before it reacts to the load.
            flushThrottled();
            emit propertyChanged(QStringLiteral("duration"), getProperty(QStringLiteral("duration")));
            emit fileLoaded();
            break;
        case MPV_EVENT_END_FILE: {
            auto *end = static_cast<mpv_event_end_file *>(event->data);
            const QString error = end->reason == MPV_END_FILE_REASON_ERROR
                ? QString::fromUtf8(mpv_error_string(end->error)) : QString();
            emit endFile(endReason(end->reason), error);
            break;
        }
        case MPV_EVENT_LOG_MESSAGE: {
            auto *msg = static_cast<mpv_event_log_message *>(event->data);
            qInfo().noquote() << "[mpv]" << msg->prefix << QString::fromUtf8(msg->text).trimmed();
            break;
        }
        case MPV_EVENT_SHUTDOWN:
            return;
        default:
            break;
        }
    }
}
