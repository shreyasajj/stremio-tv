#pragma once

// libmpv core shared by the web UI (over QWebChannel) and the video item.
//
// The web UI drives playback with command()/setOption() and listens to
// propertyChanged()/fileLoaded()/endFile(). MpvVideo only renders frames.

#include <QObject>
#include <QHash>
#include <QSet>
#include <QTimer>
#include <QVariant>
#include <QVariantMap>
#include <QtQml/qqmlregistration.h>
#include <memory>
#include <mutex>
#include <mpv/client.h>

class MpvController;
class MpvItem;

// Owned jointly by the controller and the render thread's renderer, so the
// mpv core outlives whichever of them is destroyed last. Callbacks from mpv
// threads look up their targets under the mutex.
struct MpvCore {
    mpv_handle *handle = nullptr;
    std::mutex mutex;
    MpvController *controller = nullptr;
    MpvItem *item = nullptr;
    ~MpvCore();
};

class MpvController : public QObject {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool available READ available CONSTANT)
public:
    explicit MpvController(QObject *parent = nullptr);
    ~MpvController() override;

    bool available() const { return core_ && core_->handle; }
    std::shared_ptr<MpvCore> core() const { return core_; }

    // e.g. command(["loadfile", url, "replace"])
    Q_INVOKABLE void command(const QStringList &args);
    // Set an mpv property/option at runtime (bool, number or string).
    Q_INVOKABLE void setOption(const QString &name, const QVariant &value);
    Q_INVOKABLE QVariant getProperty(const QString &name) const;
    // Several properties in one round trip (stats overlay); unavailable
    // ones are left out.
    Q_INVOKABLE QVariantMap getProperties(const QStringList &names) const;

signals:
    void propertyChanged(const QString &name, const QVariant &value);
    void fileLoaded();
    // reason: eof | stop | quit | error | redirect | unknown
    void endFile(const QString &reason, const QString &error);

private slots:
    void processEvents();
    void flushThrottled();

private:
    std::shared_ptr<MpvCore> core_;
    QHash<QString, QVariant> throttled_;
    QTimer throttleTimer_;
    void handlePropertyChange(const QString &name, const QVariant &value);
};

QVariant mpvNodeToVariant(const mpv_node *node);
