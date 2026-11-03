#pragma once

// "Set up with phone": while the TV shows the setup screen, a small web page
// on the LAN takes the broker login from a phone. The TV shows a QR code with
// the page's link (plus a one-time code); a submitted login is tested right
// away and the result shown on both screens. The page stops after one
// success, after 5 minutes, or when the TV screen closes.

#include "homeassistant.h"
#include <QHostAddress>
#include <QObject>
#include <QTimer>
#include <QVariantMap>

class QTcpServer;
class QTcpSocket;
class QUdpSocket;

class PhoneSetup : public QObject {
    Q_OBJECT
public:
    explicit PhoneSetup(QObject *parent = nullptr);
    ~PhoneSetup() override;

    // Starts (or restarts) the page; `current` pre-fills the form. Returns
    // { url, code, qrPng (data: URL) } or { error }.
    QVariantMap start(const MqttSettings &current);
    void stop();

    // For tests and the form: HA's address found over mDNS, if any.
    QString discoveredHost() const { return discoveredHost_; }

signals:
    // { phase: testing | done | expired, ok, error, settings }
    void event(const QVariantMap &event);

private:
    QTcpServer *server_ = nullptr;
    QUdpSocket *mdns_ = nullptr;
    QTimer expiry_;
    QString code_;
    MqttSettings current_;
    QString discoveredHost_;
    int badRequests_ = 0;
    bool testing_ = false;

    void onConnection();
    void handle(QTcpSocket *socket, const QByteArray &method, const QByteArray &target, const QByteArray &body);
    void submit(QTcpSocket *socket, const QByteArray &body);
    QByteArray formPage() const;
    void queryMdns();
    void readMdns();
};
