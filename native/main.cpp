#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQuickWindow>
#include <QSGRendererInterface>
#include <QCoreApplication>
#include "mpvitem.h"

int main(int argc, char **argv) {
    // QQuickFramebufferObject uses OpenGL. Force the QRhi OpenGL backend even on Wayland.
    QQuickWindow::setGraphicsApi(QSGRendererInterface::OpenGL);
    QGuiApplication app(argc, argv);
    QCoreApplication::setApplicationName("Stremio TV Native");
    qmlRegisterType<MpvItem>("StremioTV.Player", 1, 0, "MpvVideo");
    QQmlApplicationEngine engine;
    engine.loadFromModule("StremioTV", "Main");
    if (engine.rootObjects().isEmpty()) return 1;
    return app.exec();
}
