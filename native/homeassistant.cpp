#include "homeassistant.h"
#include "phonesetup.h"
#include <QCoreApplication>
#include <QDateTime>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPointer>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QTimer>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <mosquitto.h>
#include <mutex>
#include <thread>

// The broker connection runs on its own thread with libmosquitto's blocking
// API (connect, then loop): a slow DNS lookup or an unreachable broker never
// stalls the UI, and the exact error (refused, unknown host, bad login) is at
// hand to show on the TV. Publishing from the UI thread is safe in threaded
// mode; results come back through queued calls.

namespace {
constexpr int kKeepAlive = 30;
constexpr int kTestTimeoutMs = 10000;
constexpr int kMaxBackoff = 30;
const char *const kOrigin = "https://github.com/shreyasajj/stremio-tv";

void initLibrary() {
    static std::once_flag once;
    std::call_once(once, [] { mosquitto_lib_init(); });
}

QString describe(int rc, int err, const MqttSettings &s) {
    const QString where = QStringLiteral("%1:%2").arg(s.host).arg(s.port);
    switch (rc) {
    case MOSQ_ERR_ERRNO:
        return QStringLiteral("Cannot reach %1: %2").arg(where, QString::fromLocal8Bit(std::strerror(err)));
    case MOSQ_ERR_EAI:
        return QStringLiteral("Cannot find the broker address %1").arg(s.host);
    case MOSQ_ERR_CONN_LOST:
        return QStringLiteral("Lost the connection to %1").arg(where);
    default:
        return QString::fromUtf8(mosquitto_strerror(rc));
    }
}

QString connackText(int rc) {
    switch (rc) {
    case 4: return QStringLiteral("The broker rejected the username or password");
    case 5: return QStringLiteral("Not authorised: check the username and password");
    default: return QString::fromUtf8(mosquitto_connack_string(rc));
    }
}

QByteArray topic(const MqttSettings &s, const char *leaf) {
    return QStringLiteral("stremio_tv/%1/%2").arg(s.box, QLatin1String(leaf)).toUtf8();
}

QByteArray configTopic(const MqttSettings &s) {
    return QStringLiteral("homeassistant/device/stremio_tv_%1/config").arg(s.box).toUtf8();
}

// HA device-based discovery: one "Stremio TV" device with all its entities.
// The state, availability and command topics are shared by the components.
QByteArray discoveryPayload(const MqttSettings &s) {
    const QString id = QStringLiteral("stremio_tv_") + s.box;
    const QString state = QString::fromUtf8(topic(s, "state"));
    QString area = s.box;
    area.replace(QLatin1Char('_'), QLatin1Char(' '));
    if (!area.isEmpty()) area[0] = area[0].toUpper();

    auto component = [&](const char *platform, const char *key, const char *name, QJsonObject extra) {
        extra.insert(QStringLiteral("p"), QLatin1String(platform));
        extra.insert(QStringLiteral("name"), QLatin1String(name));
        extra.insert(QStringLiteral("unique_id"), id + QLatin1Char('_') + QLatin1String(key));
        return extra;
    };
    auto seconds = [&](const char *field) {
        return QJsonObject {
            { "value_template", QStringLiteral("{{ value_json.%1 }}").arg(QLatin1String(field)) },
            { "device_class", "duration" },
            { "unit_of_measurement", "s" },
        };
    };
    QJsonObject components {
        { "state", component("sensor", "state", "State", {
            { "value_template", "{{ value_json.state }}" },
            { "device_class", "enum" },
            { "options", QJsonArray { "playing", "paused", "idle" } },
            { "icon", "mdi:television-play" },
        }) },
        { "title", component("sensor", "title", "Title", {
            { "value_template", "{{ value_json.title }}" },
            { "json_attributes_topic", state },
            { "json_attributes_template",
              "{{ {'episode': value_json.episode, 'type': value_json.type, 'imdb_id': value_json.imdb_id} | tojson }}" },
            { "icon", "mdi:movie-open" },
        }) },
        { "position", component("sensor", "position", "Position", seconds("position")) },
        { "duration", component("sensor", "duration", "Duration", seconds("duration")) },
        { "progress", component("sensor", "progress", "Progress", {
            { "value_template", "{{ value_json.progress }}" },
            { "unit_of_measurement", "%" },
            { "icon", "mdi:progress-clock" },
        }) },
        { "poster", component("image", "poster", "Poster", {
            { "url_topic", state },
            { "url_template", "{{ value_json.poster }}" },
        }) },
        { "play_pause", component("button", "play_pause", "Play/Pause", {
            { "payload_press", "toggle" }, { "icon", "mdi:play-pause" } }) },
        { "stop", component("button", "stop", "Stop", {
            { "payload_press", "stop" }, { "icon", "mdi:stop" } }) },
        { "skip_forward", component("button", "skip_forward", "Skip forward", {
            { "payload_press", "seek:+30" }, { "icon", "mdi:fast-forward-30" } }) },
    };
    const QJsonObject root {
        { "dev", QJsonObject {
            { "ids", QJsonArray { id } },
            { "name", "Stremio TV" },
            { "mf", "Stremio TV" },
            { "mdl", "Stremio TV for Plasma Bigscreen" },
            { "sw", STREMIO_TV_VERSION },
            { "sa", area },
        } },
        { "o", QJsonObject { { "name", "Stremio TV" }, { "sw", STREMIO_TV_VERSION }, { "url", kOrigin } } },
        { "cmps", components },
        { "state_topic", state },
        { "availability_topic", QString::fromUtf8(topic(s, "availability")) },
        { "command_topic", QString::fromUtf8(topic(s, "command")) },
        { "qos", 1 },
    };
    return QJsonDocument(root).toJson(QJsonDocument::Compact);
}

// The UI's state, normalised to the documented message.
QByteArray statePayload(const QVariantMap &in) {
    auto text = [&](const char *key) -> QJsonValue {
        const QString v = in.value(QLatin1String(key)).toString().trimmed();
        return v.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(v);
    };
    auto number = [&](const char *key, bool whole) -> QJsonValue {
        bool ok = false;
        const double v = in.value(QLatin1String(key)).toDouble(&ok);
        if (!ok || !std::isfinite(v) || v < 0 || in.value(QLatin1String(key)).isNull()) return QJsonValue(QJsonValue::Null);
        return whole ? QJsonValue(qint64(std::llround(v))) : QJsonValue(std::round(v * 10) / 10);
    };
    QString state = in.value(QStringLiteral("state")).toString();
    if (state != QLatin1String("playing") && state != QLatin1String("paused")) state = QStringLiteral("idle");
    const QJsonObject out {
        { "state", state },
        { "title", text("title") },
        { "type", text("type") },
        { "episode", text("episode") },
        { "position", number("position", true) },
        { "duration", number("duration", true) },
        { "progress", number("progress", false) },
        { "poster", text("poster") },
        { "imdb_id", text("imdb_id") },
        { "updated_at", QDateTime::currentDateTimeUtc().toString(Qt::ISODate) },
    };
    return QJsonDocument(out).toJson(QJsonDocument::Compact);
}

bool publishRetained(mosquitto *m, const QByteArray &t, const QByteArray &payload) {
    return mosquitto_publish(m, nullptr, t.constData(), int(payload.size()), payload.constData(), 1, true)
        == MOSQ_ERR_SUCCESS;
}
} // namespace

MqttSettings MqttSettings::fromVariant(const QVariantMap &map) {
    MqttSettings s;
    s.host = map.value(QStringLiteral("host")).toString().trimmed();
    const int port = map.value(QStringLiteral("port")).toInt();
    s.port = port > 0 && port < 65536 ? port : 1883;
    s.username = map.value(QStringLiteral("username")).toString();
    s.password = map.value(QStringLiteral("password")).toString();
    s.box = HomeAssistant::sanitizeBox(map.value(QStringLiteral("box")).toString());
    return s;
}

QString HomeAssistant::sanitizeBox(const QString &box) {
    QString b = box.trimmed().toLower();
    b.replace(QRegularExpression(QStringLiteral("[^a-z0-9_]+")), QStringLiteral("_"));
    b.remove(QRegularExpression(QStringLiteral("^_+|_+$")));
    return b.isEmpty() ? QStringLiteral("living_room") : b.left(64);
}

// ---- the connection thread ----------------------------------------------

struct HomeAssistant::Link {
    MqttSettings cfg;
    QByteArray stateTopic, availabilityTopic, commandTopic, configTopic, discovery;
    std::mutex mutex;
    std::condition_variable cv;
    mosquitto *mosq = nullptr;   // null once destroyed
    HomeAssistant *owner = nullptr; // null once the owner let go
    QByteArray lastState;
    bool stop = false;
    bool clearRetained = false;  // on stop: remove this box's topics (renamed)
    bool sessionUp = false;
    bool refused = false;        // CONNACK said no; already reported
    bool finished = false;

    // Runs fn on the owner's thread, unless the owner has moved on.
    void post(std::function<void(HomeAssistant *)> fn) {
        std::lock_guard<std::mutex> lock(mutex);
        if (!owner) return;
        HomeAssistant *o = owner;
        QMetaObject::invokeMethod(o, [o, fn] { fn(o); }, Qt::QueuedConnection);
    }
    void report(const QString &state, const QString &error = QString()) {
        post([state, error](HomeAssistant *o) { o->setStatus(state, error); });
    }

    static void onConnect(mosquitto *m, void *obj, int rc) {
        auto *L = static_cast<Link *>(obj);
        if (rc != 0) {
            { std::lock_guard<std::mutex> lock(L->mutex); L->refused = true; }
            L->report(QStringLiteral("error"), connackText(rc));
            return;
        }
        {
            std::lock_guard<std::mutex> lock(L->mutex);
            L->sessionUp = true;
            mosquitto_subscribe(m, nullptr, L->commandTopic.constData(), 1);
            publishRetained(m, L->configTopic, L->discovery);
            publishRetained(m, L->availabilityTopic, "online");
            publishRetained(m, L->stateTopic, L->lastState.isEmpty() ? statePayload({}) : L->lastState);
        }
        L->report(QStringLiteral("connected"));
    }

    static void onMessage(mosquitto *, void *obj, const mosquitto_message *msg) {
        auto *L = static_cast<Link *>(obj);
        if (!msg->topic || L->commandTopic != msg->topic || msg->payloadlen <= 0 || msg->payloadlen > 64) return;
        const QString cmd = QString::fromUtf8(static_cast<const char *>(msg->payload), msg->payloadlen).trimmed().toLower();
        L->post([cmd](HomeAssistant *o) { emit o->command(cmd); });
    }

    static void run(std::shared_ptr<Link> L) {
        mosquitto *m = L->mosq;
        const QByteArray host = L->cfg.host.toUtf8();
        bool connected = false;
        bool failing = false;
        int backoff = 2;
        auto stopping = [&] { std::lock_guard<std::mutex> lock(L->mutex); return L->stop; };
        auto pause = [&] {
            std::unique_lock<std::mutex> lock(L->mutex);
            L->cv.wait_for(lock, std::chrono::seconds(backoff), [&] { return L->stop; });
            backoff = std::min(backoff * 2, kMaxBackoff);
        };
        while (!stopping()) {
            if (!connected) {
                if (!failing) L->report(QStringLiteral("connecting"));
                const int rc = mosquitto_connect(m, host.constData(), L->cfg.port, kKeepAlive);
                const int err = errno;
                if (rc != MOSQ_ERR_SUCCESS) {
                    failing = true;
                    L->report(QStringLiteral("error"), describe(rc, err, L->cfg));
                    pause();
                    continue;
                }
                connected = true;
            }
            const int rc = mosquitto_loop(m, 200, 1);
            const int err = errno;
            bool refused = false;
            {
                std::lock_guard<std::mutex> lock(L->mutex);
                if (L->sessionUp) { backoff = 2; failing = false; }
                if (rc != MOSQ_ERR_SUCCESS) {
                    L->sessionUp = false;
                    refused = L->refused;
                    L->refused = false;
                }
            }
            if (rc == MOSQ_ERR_SUCCESS) continue;
            connected = false;
            failing = true;
            if (!refused) L->report(QStringLiteral("error"), describe(rc, err, L->cfg));
            pause();
        }

        // Going away on purpose (quit, turned off, new settings): say so,
        // since a clean disconnect does not trigger the last will.
        bool up;
        { std::lock_guard<std::mutex> lock(L->mutex); up = L->sessionUp; }
        if (connected && up) {
            if (L->clearRetained) {
                publishRetained(m, L->configTopic, QByteArray());
                publishRetained(m, L->stateTopic, QByteArray());
                publishRetained(m, L->availabilityTopic, QByteArray());
            } else {
                publishRetained(m, L->availabilityTopic, "offline");
            }
            mosquitto_disconnect(m);
            for (int i = 0; i < 20 && mosquitto_loop(m, 50, 1) == MOSQ_ERR_SUCCESS; i++) {}
        }
        {
            std::lock_guard<std::mutex> lock(L->mutex);
            L->mosq = nullptr;
            L->sessionUp = false;
        }
        mosquitto_destroy(m);
        std::lock_guard<std::mutex> lock(L->mutex);
        L->finished = true;
        L->cv.notify_all();
    }
};

HomeAssistant::HomeAssistant(QObject *parent) : QObject(parent) {
    initLibrary();
    status_ = { { "state", "off" }, { "error", "" } };
}

HomeAssistant::~HomeAssistant() {
    std::shared_ptr<Link> link = link_;
    stopLink(false);
    // Give the thread a moment to tell the broker we are going offline.
    if (link) {
        std::unique_lock<std::mutex> lock(link->mutex);
        link->cv.wait_for(lock, std::chrono::milliseconds(1500), [&] { return link->finished; });
    }
}

void HomeAssistant::configure(const QVariantMap &map) {
    const bool enabled = map.value(QStringLiteral("enabled")).toBool();
    const MqttSettings s = MqttSettings::fromVariant(map);
    if (!enabled || s.host.isEmpty()) {
        stopLink(false);
        settings_ = s;
        setStatus(QStringLiteral("off"));
        return;
    }
    if (link_ && s == settings_) return;
    // A renamed box takes its old retained topics (and HA device) with it.
    stopLink(link_ && s.box != settings_.box);
    settings_ = s;
    startLink();
}

void HomeAssistant::startLink() {
    auto L = std::make_shared<Link>();
    L->cfg = settings_;
    L->owner = this;
    L->lastState = lastState_;
    L->stateTopic = topic(settings_, "state");
    L->availabilityTopic = topic(settings_, "availability");
    L->commandTopic = topic(settings_, "command");
    L->configTopic = configTopic(settings_);
    L->discovery = discoveryPayload(settings_);
    const QByteArray clientId = QStringLiteral("stremio_tv_%1").arg(settings_.box).toUtf8();
    L->mosq = mosquitto_new(clientId.constData(), true, L.get());
    if (!L->mosq) {
        setStatus(QStringLiteral("error"), QStringLiteral("Could not start the MQTT client"));
        return;
    }
    mosquitto_threaded_set(L->mosq, true);
    mosquitto_will_set(L->mosq, L->availabilityTopic.constData(), 7, "offline", 1, true);
    if (!settings_.username.isEmpty()) {
        mosquitto_username_pw_set(L->mosq, settings_.username.toUtf8().constData(),
                                  settings_.password.isEmpty() ? nullptr : settings_.password.toUtf8().constData());
    }
    mosquitto_connect_callback_set(L->mosq, &Link::onConnect);
    mosquitto_message_callback_set(L->mosq, &Link::onMessage);
    link_ = L;
    setStatus(QStringLiteral("connecting"));
    std::thread(&Link::run, L).detach();
}

void HomeAssistant::stopLink(bool clearRetained) {
    if (!link_) return;
    {
        std::lock_guard<std::mutex> lock(link_->mutex);
        link_->stop = true;
        link_->clearRetained = clearRetained;
        link_->owner = nullptr;
    }
    link_->cv.notify_all();
    link_.reset();
}

void HomeAssistant::publish(const QVariantMap &state) {
    lastState_ = statePayload(state);
    if (!link_) return;
    std::lock_guard<std::mutex> lock(link_->mutex);
    link_->lastState = lastState_;
    if (link_->sessionUp && link_->mosq) publishRetained(link_->mosq, link_->stateTopic, lastState_);
}

void HomeAssistant::setStatus(const QString &state, const QString &error) {
    status_ = {
        { "state", state },
        { "error", error },
        { "host", settings_.host },
        { "port", settings_.port },
        { "box", settings_.box },
    };
    emit statusChanged(status_);
}

// ---- connection test -----------------------------------------------------

void HomeAssistant::runTest(const MqttSettings &s, QObject *context, std::function<void(QString)> done) {
    initLibrary();
    // Whichever comes first, the answer or the timeout, is reported; both run
    // on the main thread.
    auto answered = std::make_shared<bool>(false);
    QPointer<QObject> ctx(context);
    auto finish = [answered, ctx, done](const QString &error) {
        if (*answered || !ctx) return;
        *answered = true;
        done(error);
    };
    if (s.host.isEmpty()) { finish(QStringLiteral("Enter the broker address first")); return; }
    QTimer::singleShot(kTestTimeoutMs, context, [finish, s] {
        finish(QStringLiteral("No answer from %1:%2").arg(s.host).arg(s.port));
    });

    std::thread([s, finish] {
        struct Result { bool got = false; int rc = 0; } result;
        const QByteArray clientId = QStringLiteral("stremio_tv_%1_test_%2")
            .arg(s.box).arg(QRandomGenerator::global()->generate() % 100000).toUtf8();
        mosquitto *m = mosquitto_new(clientId.constData(), true, &result);
        QString error;
        if (!m) {
            error = QStringLiteral("Could not start the MQTT client");
        } else {
            if (!s.username.isEmpty()) {
                mosquitto_username_pw_set(m, s.username.toUtf8().constData(),
                                          s.password.isEmpty() ? nullptr : s.password.toUtf8().constData());
            }
            mosquitto_connect_callback_set(m, [](mosquitto *, void *obj, int rc) {
                auto *r = static_cast<Result *>(obj);
                r->got = true;
                r->rc = rc;
            });
            int rc = mosquitto_connect(m, s.host.toUtf8().constData(), s.port, kKeepAlive);
            int err = errno;
            if (rc != MOSQ_ERR_SUCCESS) {
                error = describe(rc, err, s);
            } else {
                const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(kTestTimeoutMs);
                while (!result.got && std::chrono::steady_clock::now() < end) {
                    rc = mosquitto_loop(m, 100, 1);
                    err = errno;
                    if (rc != MOSQ_ERR_SUCCESS) break;
                }
                if (result.got && result.rc != 0) error = connackText(result.rc);
                else if (!result.got && rc != MOSQ_ERR_SUCCESS) error = describe(rc, err, s);
                else if (!result.got) error = QStringLiteral("No answer from %1:%2").arg(s.host).arg(s.port);
                mosquitto_disconnect(m);
                mosquitto_loop(m, 50, 1);
            }
            mosquitto_destroy(m);
        }
        QMetaObject::invokeMethod(QCoreApplication::instance(), [finish, error] { finish(error); }, Qt::QueuedConnection);
    }).detach();
}

void HomeAssistant::testConnection(const QVariantMap &settings, int requestId) {
    runTest(MqttSettings::fromVariant(settings), this, [this, requestId](const QString &error) {
        emit testDone(requestId, { { "ok", error.isEmpty() }, { "error", error } });
    });
}

// ---- phone setup -----------------------------------------------------------

QVariantMap HomeAssistant::startPhoneSetup(const QVariantMap &current) {
    if (!setup_) {
        setup_ = new PhoneSetup(this);
        connect(setup_, &PhoneSetup::event, this, &HomeAssistant::setupEvent);
    }
    return setup_->start(MqttSettings::fromVariant(current));
}

void HomeAssistant::stopPhoneSetup() {
    if (setup_) setup_->stop();
}
