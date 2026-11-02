#pragma once

// The native counterpart of the Electron preload (`window.shell`): exposed to
// the web UI over QWebChannel and wrapped by bridge.js.

#include <QObject>
#include <QUrl>
#include <QVariantMap>
#include <QtQml/qqmlregistration.h>

class QNetworkAccessManager;

class ShellBridge : public QObject {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(QUrl uiUrl READ uiUrl CONSTANT)
    Q_PROPERTY(QString injectScript READ injectScript CONSTANT)
    Q_PROPERTY(bool windowed READ windowed CONSTANT)
    Q_PROPERTY(bool testMode READ testMode CONSTANT)
public:
    explicit ShellBridge(QObject *parent = nullptr);
    ~ShellBridge() override;

    QUrl uiUrl() const;
    QString injectScript() const;
    bool windowed() const;
    bool testMode() const;

    // Fetch text (subtitles) without CORS; answers via proxyFetchDone(id, …).
    Q_INVOKABLE void proxyFetch(const QString &url, int requestId);
    Q_INVOKABLE QString readClipboard() const;
    Q_INVOKABLE void quit();
    // Inhibit the screensaver only while something is playing.
    Q_INVOKABLE void setPlaybackActive(bool playing);
    // Test hook (STREMIO_TV_TEST=1): save the composited window — video
    // included — as a PNG.
    Q_INVOKABLE bool saveScreenshot(const QString &path);

signals:
    void proxyFetchDone(int requestId, const QVariantMap &result);
    void windowBlur();
    void windowFocus();

private:
    QNetworkAccessManager *net_;
    uint inhibitCookie_ = 0;
    bool inhibitPending_ = false;
    bool wantInhibit_ = false;
    void updateInhibit();
};
