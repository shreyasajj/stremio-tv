#include "shellbridge.h"
#include <QClipboard>
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QImage>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QQuickWindow>
#ifdef STREMIO_TV_HAVE_DBUS
#include <QDBusConnection>
#include <QDBusMessage>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>
#endif

namespace {
constexpr qint64 kMaxFetchBytes = 10 * 1024 * 1024;

bool envFlag(const char *name) {
    const QByteArray v = qgetenv(name);
    return !v.isEmpty() && v != "0";
}

QString readText(const QString &path) {
    QFile f(path);
    return f.open(QIODevice::ReadOnly) ? QString::fromUtf8(f.readAll()) : QString();
}
} // namespace

ShellBridge::ShellBridge(QObject *parent) : QObject(parent), net_(new QNetworkAccessManager(this)) {}

ShellBridge::~ShellBridge() {
    wantInhibit_ = false;
    updateInhibit();
}

QUrl ShellBridge::uiUrl() const {
    // 1. explicit override, 2. installed copy next to the binary, 3. the
    // source tree this binary was built from (development builds).
    const QString override = qEnvironmentVariable("STREMIO_TV_UI");
    if (!override.isEmpty()) return QUrl::fromLocalFile(QFileInfo(override).absoluteFilePath());
    const QString installed = QDir(QCoreApplication::applicationDirPath())
        .filePath(QStringLiteral("../share/stremio-tv/ui/index.html"));
    if (QFileInfo::exists(installed)) return QUrl::fromLocalFile(QFileInfo(installed).canonicalFilePath());
    return QUrl::fromLocalFile(QStringLiteral(STREMIO_TV_SOURCE_UI "/index.html"));
}

QString ShellBridge::injectScript() const {
    // qwebchannel.js ships inside QtWebChannel's resources; bridge.js builds
    // `window.shell` on top of it.
    return readText(QStringLiteral(":/qtwebchannel/qwebchannel.js")) + QStringLiteral("\n")
        + readText(QStringLiteral(":/qt/qml/StremioTV/Native/bridge.js"));
}

bool ShellBridge::windowed() const { return envFlag("STREMIO_TV_WINDOWED"); }
bool ShellBridge::testMode() const { return envFlag("STREMIO_TV_TEST"); }

void ShellBridge::proxyFetch(const QString &url, int requestId) {
    const QUrl target(url);
    if (target.scheme() != QLatin1String("http") && target.scheme() != QLatin1String("https")) {
        emit proxyFetchDone(requestId, { { "ok", false }, { "status", 0 }, { "contentType", "" },
                                         { "body", "" }, { "error", "Only http(s) URLs allowed" } });
        return;
    }
    QNetworkRequest request(target);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::NoLessSafeRedirectPolicy);
    QNetworkReply *reply = net_->get(request);
    connect(reply, &QNetworkReply::downloadProgress, reply, [reply](qint64 received, qint64) {
        if (received > kMaxFetchBytes) reply->abort();
    });
    connect(reply, &QNetworkReply::finished, this, [this, reply, requestId] {
        reply->deleteLater();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const QByteArray body = reply->readAll();
        QVariantMap result {
            { "ok", reply->error() == QNetworkReply::NoError && status >= 200 && status < 300 },
            { "status", status },
            { "contentType", reply->header(QNetworkRequest::ContentTypeHeader).toString() },
            { "body", QString::fromUtf8(body) },
        };
        if (reply->error() != QNetworkReply::NoError) result.insert("error", reply->errorString());
        emit proxyFetchDone(requestId, result);
    });
}

QString ShellBridge::readClipboard() const {
    return QGuiApplication::clipboard()->text();
}

void ShellBridge::quit() {
    QCoreApplication::quit();
}

void ShellBridge::setPlaybackActive(bool playing) {
    wantInhibit_ = playing;
    updateInhibit();
}

void ShellBridge::updateInhibit() {
#ifdef STREMIO_TV_HAVE_DBUS
    if (inhibitPending_) return; // re-evaluated when the pending call returns
    auto bus = QDBusConnection::sessionBus();
    if (!bus.isConnected()) return;
    if (wantInhibit_ && !inhibitCookie_) {
        QDBusMessage msg = QDBusMessage::createMethodCall(
            QStringLiteral("org.freedesktop.ScreenSaver"), QStringLiteral("/ScreenSaver"),
            QStringLiteral("org.freedesktop.ScreenSaver"), QStringLiteral("Inhibit"));
        msg << QStringLiteral("Stremio TV") << QStringLiteral("Playing video");
        inhibitPending_ = true;
        auto *watcher = new QDBusPendingCallWatcher(bus.asyncCall(msg), this);
        connect(watcher, &QDBusPendingCallWatcher::finished, this, [this](QDBusPendingCallWatcher *w) {
            QDBusPendingReply<uint> reply = *w;
            w->deleteLater();
            inhibitPending_ = false;
            if (reply.isValid()) inhibitCookie_ = reply.value();
            updateInhibit();
        });
    } else if (!wantInhibit_ && inhibitCookie_) {
        QDBusMessage msg = QDBusMessage::createMethodCall(
            QStringLiteral("org.freedesktop.ScreenSaver"), QStringLiteral("/ScreenSaver"),
            QStringLiteral("org.freedesktop.ScreenSaver"), QStringLiteral("UnInhibit"));
        msg << inhibitCookie_;
        inhibitCookie_ = 0;
        bus.asyncCall(msg);
    }
#endif
}

bool ShellBridge::saveScreenshot(const QString &path) {
    if (!testMode()) return false;
    for (QWindow *w : QGuiApplication::topLevelWindows()) {
        if (auto *quick = qobject_cast<QQuickWindow *>(w)) return quick->grabWindow().save(path);
    }
    return false;
}
