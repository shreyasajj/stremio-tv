#include "bridgecontrol.h"
#include <QDBusConnection>
#include <QDateTime>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QTimer>
#include <cmath>

namespace {
QVariantMap failure(const QString &code, const QString &message) {
    return {{"ok", false}, {"error", QVariantMap{{"code", code}, {"message", message}}}};
}
bool validContentId(const QJsonValue &value) {
    static const QRegularExpression pattern(QStringLiteral("^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}\\z"));
    return value.isString() && pattern.match(value.toString()).hasMatch();
}
}

QString BridgeControl::serviceName() { return QStringLiteral("io.github.shreyasajj.StremioTV.Control"); }
QString BridgeControl::objectPath() { return QStringLiteral("/io/github/shreyasajj/StremioTV/Control"); }

BridgeControl::BridgeControl(QObject *parent) : QObject(parent) {
    QDBusConnection::sessionBus().registerObject(objectPath(), this, QDBusConnection::ExportAllSlots);
}

QVariantMap BridgeControl::snapshot() const {
    return {{"protocol", 1}, {"ready", ready_},
            {"content_types", QStringList{"movie", "series", "episode"}},
            {"capabilities", QStringList{"play", "pause", "stop", "seek"}}, {"media", state_}};
}

QString BridgeControl::answer(const QString &id, const QVariantMap &body) const {
    auto result = body;
    result.insert("id", id);
    return QString::fromUtf8(QJsonDocument::fromVariant(result).toJson(QJsonDocument::Compact));
}

void BridgeControl::remember(const QString &id, const QJsonObject &request, const QString &response) {
    if (!cache_.contains(id)) order_.enqueue(id);
    cache_.insert(id, {request, response});
    while (order_.size() > 128) cache_.remove(order_.dequeue());
}

QString BridgeControl::Execute(const QString &payload) {
    const auto doc = QJsonDocument::fromJson(payload.toUtf8());
    const auto req = doc.object();
    const QString id = req.value("id").toString();
    auto error = [&](const char *code, const char *message) { return answer(id, failure(code, message)); };
    if (payload.toUtf8().size() > 16384 || !doc.isObject() || id.isEmpty() || id.size() > 128)
        return error("invalid_request", "A bounded JSON request and string ID are required");
    if (cache_.contains(id)) {
        const auto cached = cache_.value(id);
        return cached.request == req ? cached.response : error("invalid_request", "Request ID reused with different data");
    }
    if (pending_.contains(id)) {
        if (pending_.value(id).request != req) return error("invalid_request", "Request ID reused with different data");
        if (calledFromDBus()) { setDelayedReply(true); pending_[id].replies.append(message()); }
        return {};
    }
    const QString command = req.value("command").toString();
    QStringList allowed{"id", "command"};
    if (command == "open") allowed << "content_type" << "content_id" << "resume";
    else if (command == "seek") allowed << "position";
    else if (!QStringList{"get_state", "focus", "play", "pause", "stop"}.contains(command))
        return error("unsupported", "Unsupported command");
    for (auto it = req.begin(); it != req.end(); ++it)
        if (!allowed.contains(it.key())) return error("invalid_request", "Unknown request fields");
    if (command == "open") {
        const QString type = req.value("content_type").toString();
        if (!QStringList{"movie", "series", "episode"}.contains(type)) return error("unsupported", "Unsupported content type");
        if (req.contains("resume") && !req.value("resume").isBool()) return error("invalid_request", "Resume must be boolean");
        if (type == "episode") {
            const auto content = req.value("content_id").toObject();
            if (content.size() != 2 || !validContentId(content.value("series_id")) || !validContentId(content.value("video_id")))
                return error("invalid_request", "Episode requires series_id and video_id");
        } else if (!validContentId(req.value("content_id"))) return error("invalid_request", "Invalid Stremio ID");
    }
    if (command == "seek" && (!req.value("position").isDouble() || !std::isfinite(req.value("position").toDouble())
                              || req.value("position").toDouble() < 0))
        return error("invalid_request", "Seek position must be finite and nonnegative");
    if (command == "get_state") {
        const auto response = answer(id, {{"ok", true}, {"result", snapshot()}});
        remember(id, req, response);
        return response;
    }
    if (command == "focus") {
        emit focusRequested();
        const auto response = answer(id, {{"ok", true}, {"result", QVariantMap{{"focused", true}}}});
        remember(id, req, response);
        return response;
    }
    if (!ready_) return error("not_ready", "The application renderer is not ready");
    if (!pending_.isEmpty()) return error("busy", "Another application command is in progress");
    if (!calledFromDBus()) return error("invalid_request", "Use the local D-Bus endpoint");
    setDelayedReply(true);
    pending_.insert(id, {req, {message()}});
    QTimer::singleShot(20000, this, [this, id] {
        if (pending_.contains(id)) {
            emit cancelled(id);
            complete(id, failure("command_timeout", "Renderer did not acknowledge the command"));
        }
    });
    emit requested(req.toVariantMap());
    return {};
}

void BridgeControl::complete(const QString &id, const QVariantMap &response) {
    if (!pending_.contains(id)) return;
    const auto pending = pending_.take(id);
    const auto result = answer(id, response);
    remember(id, pending.request, result);
    for (const auto &request : pending.replies)
        QDBusConnection::sessionBus().send(request.createReply(QVariantList{result}));
}

void BridgeControl::setReady(bool ready) {
    ready_ = ready;
    if (!ready) {
        state_.clear();
        const auto keys = pending_.keys();
        for (const auto &id : keys) {
            emit cancelled(id);
            complete(id, failure("not_ready", "Application renderer became unavailable"));
        }
    }
}

void BridgeControl::publish(const QVariantMap &state) {
    QVariantMap clean;
    for (const char *key : {"title", "episode", "poster", "type", "imdb_id", "content_id", "video_id"}) {
        const QString value = state.value(key).toString();
        if (value.size() <= 2048) clean.insert(key, value);
    }
    QString playback = state.value("state").toString();
    clean.insert("state", QStringList{"playing", "paused"}.contains(playback) ? playback : QStringLiteral("idle"));
    for (const char *key : {"position", "duration"}) {
        bool ok = false;
        const double number = state.value(key).toDouble(&ok);
        if (ok && std::isfinite(number) && number >= 0 && !state.value(key).isNull()) clean.insert(key, number);
    }
    clean.insert("updated_at", QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs));
    state_ = clean;
}
