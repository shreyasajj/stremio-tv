#include "shellbridge.h"
#include <QClipboard>
#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QImage>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QQuickWindow>
#include <unistd.h>
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

QVariantMap ShellBridge::systemStats() {
    QVariantMap out;
    const long cores = sysconf(_SC_NPROCESSORS_ONLN);
    const long hz = sysconf(_SC_CLK_TCK);
    out.insert(QStringLiteral("cores"), qlonglong(cores));
    const qint64 nowMs = QDateTime::currentMSecsSinceEpoch();

    // /proc/stat "cpu  user nice system idle iowait irq softirq steal …"
    const QStringList cpu = readText(QStringLiteral("/proc/stat")).section(u'\n', 0, 0)
        .split(u' ', Qt::SkipEmptyParts);
    quint64 total = 0, idle = 0;
    for (int i = 1; i < cpu.size() && i <= 8; ++i) {
        const quint64 v = cpu.at(i).toULongLong();
        total += v;
        if (i == 4 || i == 5) idle += v;
    }
    // /proc/self/stat: utime and stime are fields 14 and 15; the command
    // name in parentheses may contain spaces, so count from the last ')'.
    const QString self = readText(QStringLiteral("/proc/self/stat"));
    const QStringList fields = self.mid(self.lastIndexOf(u')') + 2).split(u' ', Qt::SkipEmptyParts);
    const quint64 procTicks = fields.size() > 12 ? fields.at(11).toULongLong() + fields.at(12).toULongLong() : 0;

    if (lastStatsMs_ && total > lastCpuTotal_) {
        const double dTotal = double(total - lastCpuTotal_);
        out.insert(QStringLiteral("cpu"), 100.0 * (1.0 - double(idle - lastCpuIdle_) / dTotal));
        const double seconds = (nowMs - lastStatsMs_) / 1000.0;
        if (seconds > 0 && hz > 0)
            out.insert(QStringLiteral("process"), 100.0 * double(procTicks - lastProcTicks_) / hz / seconds);
    }
    lastCpuTotal_ = total;
    lastCpuIdle_ = idle;
    lastProcTicks_ = procTicks;
    lastStatsMs_ = nowMs;

    // GPU busy %, where the kernel driver exposes it (amdgpu does).
    QDirIterator cards(QStringLiteral("/sys/class/drm"), { QStringLiteral("card?") }, QDir::Dirs | QDir::System);
    while (cards.hasNext()) {
        const QString busy = readText(cards.next() + QStringLiteral("/device/gpu_busy_percent")).trimmed();
        if (!busy.isEmpty()) { out.insert(QStringLiteral("gpu"), busy.toInt()); break; }
    }
    return out;
}

void ShellBridge::setVideoLayer(bool visible) {
    if (videoLayer_ == visible) return;
    videoLayer_ = visible;
    emit videoLayerChanged();
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
