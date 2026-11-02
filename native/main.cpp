#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQuickWindow>
#include <QSGRendererInterface>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>
#include <clocale>

int main(int argc, char **argv) {
    // MpvVideo renders with OpenGL; make Qt Quick use it on Wayland and X11.
    QQuickWindow::setGraphicsApi(QSGRendererInterface::OpenGL);
    // TV boxes: play without a click. Merged with any user-provided flags.
    qputenv("QTWEBENGINE_CHROMIUM_FLAGS",
            qgetenv("QTWEBENGINE_CHROMIUM_FLAGS") + " --autoplay-policy=no-user-gesture-required");
    QtWebEngineQuick::initialize();

    QGuiApplication app(argc, argv);
    QCoreApplication::setOrganizationName(QStringLiteral("StremioTV"));
    QCoreApplication::setApplicationName(QStringLiteral("stremio-tv"));
    QGuiApplication::setApplicationDisplayName(QStringLiteral("Stremio TV"));
    // Wayland app_id: matches the .desktop file so the launcher/taskbar pair up.
    QGuiApplication::setDesktopFileName(QStringLiteral(STREMIO_TV_APP_ID));
    // libmpv parses numbers with the C locale.
    std::setlocale(LC_NUMERIC, "C");

    QQmlApplicationEngine engine;
    QObject::connect(&engine, &QQmlApplicationEngine::objectCreationFailed, &app,
                     [] { QCoreApplication::exit(1); }, Qt::QueuedConnection);
    engine.loadFromModule("StremioTV.Native", "Main");
    return app.exec();
}
