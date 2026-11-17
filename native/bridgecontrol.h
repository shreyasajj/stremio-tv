#pragma once

#include <QObject>
#include <QDBusContext>
#include <QDBusMessage>
#include <QHash>
#include <QJsonObject>
#include <QQueue>
#include <QVariantMap>
#include <QtQml/qqmlregistration.h>

// UI/player commands over the session bus. The renderer acknowledges only fixed
// operations; no arbitrary JavaScript, URLs, settings or credentials are exposed.
class BridgeControl : public QObject, protected QDBusContext {
    Q_OBJECT
    QML_ELEMENT
    Q_CLASSINFO("D-Bus Interface", "io.github.shreyasajj.StremioTV.Control")
public:
    explicit BridgeControl(QObject *parent = nullptr);
    static QString serviceName();
    static QString objectPath();
    Q_INVOKABLE void setReady(bool ready);
    Q_INVOKABLE void publish(const QVariantMap &state);
    Q_INVOKABLE void complete(const QString &id, const QVariantMap &response);

public slots:
    QString Execute(const QString &payload);

signals:
    // Exported on the session bus so listeners need not poll; carries no data.
    Q_SCRIPTABLE void StateChanged();
    void requested(const QVariantMap &request);
    void focusRequested();
    void cancelled(const QString &id);

private:
    struct Pending { QJsonObject request; QList<QDBusMessage> replies; };
    struct Cached { QJsonObject request; QString response; };
    bool ready_ = false;
    QVariantMap state_;
    QHash<QString, Pending> pending_;
    QHash<QString, Cached> cache_;
    QQueue<QString> order_;
    QVariantMap snapshot() const;
    QString answer(const QString &id, const QVariantMap &body) const;
    void remember(const QString &id, const QJsonObject &request, const QString &response);
};
