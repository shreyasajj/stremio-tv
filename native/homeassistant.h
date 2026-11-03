#pragma once

// Home Assistant over MQTT: `window.shell.homeAssistant` for the web UI.
//
// The UI hands over the broker settings (configure) and what is playing
// (publish); this keeps one connection to the broker with a last will, so HA
// sees "offline" the moment the process dies, publishes HA's MQTT discovery,
// and passes commands from HA back to the UI. The phone setup page lives in
// PhoneSetup.

#include <QObject>
#include <QVariantMap>
#include <QtQml/qqmlregistration.h>
#include <functional>
#include <memory>

class PhoneSetup;

// Broker settings, as stored by the UI.
struct MqttSettings {
    QString host;
    int port = 1883;
    QString username;
    QString password;
    QString box = QStringLiteral("living_room");

    static MqttSettings fromVariant(const QVariantMap &map);
    bool operator==(const MqttSettings &o) const {
        return host == o.host && port == o.port && username == o.username && password == o.password && box == o.box;
    }
    bool operator!=(const MqttSettings &o) const { return !(*this == o); }
};

class HomeAssistant : public QObject {
    Q_OBJECT
    QML_ELEMENT
public:
    explicit HomeAssistant(QObject *parent = nullptr);
    ~HomeAssistant() override;

    // { enabled, host, port, username, password, box }. Reconnects only when
    // something changed; disabled (or no host) disconnects.
    Q_INVOKABLE void configure(const QVariantMap &settings);
    // What is playing: { state, title, type, episode, position, duration,
    // progress, poster, imdb_id }. Retained; resent on every reconnect.
    Q_INVOKABLE void publish(const QVariantMap &state);
    // { state: off | connecting | connected | error, error, host, port, box }
    Q_INVOKABLE QVariantMap status() const { return status_; }
    // Connect once with these settings; answers via testDone(id, { ok, error }).
    Q_INVOKABLE void testConnection(const QVariantMap &settings, int requestId);
    // Serve the phone setup page; returns { url, code, qrSvg } or { error }.
    // Progress arrives via setupEvent.
    Q_INVOKABLE QVariantMap startPhoneSetup(const QVariantMap &current);
    Q_INVOKABLE void stopPhoneSetup();

    // Runs the connection test off the UI thread; `done(error)` is called on
    // `context`'s thread, with an empty error on success.
    static void runTest(const MqttSettings &settings, QObject *context, std::function<void(QString)> done);
    static QString sanitizeBox(const QString &box);

signals:
    void statusChanged(const QVariantMap &status);
    // play | pause | toggle | stop | seek:+30 | seek:-30
    void command(const QString &command);
    void testDone(int requestId, const QVariantMap &result);
    // { phase: testing | done | expired, ok, error, settings }
    void setupEvent(const QVariantMap &event);

private:
    struct Link;
    std::shared_ptr<Link> link_;
    MqttSettings settings_;
    QVariantMap status_;
    QByteArray lastState_; // carried over to a new connection
    PhoneSetup *setup_ = nullptr;

    void startLink();

    void stopLink(bool clearRetained);
    void setStatus(const QString &state, const QString &error = QString());
};
