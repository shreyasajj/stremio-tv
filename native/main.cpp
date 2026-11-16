#include "bridgecontrol.h"
#include <QGuiApplication>
#include <QDBusConnection>
#include <QDBusInterface>
#include <QJsonDocument>
#include <QUuid>
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

    auto bus = QDBusConnection::sessionBus();
    if (!bus.isConnected()) return 1;
    if (!bus.registerService(BridgeControl::serviceName())) {
        QDBusInterface existing(BridgeControl::serviceName(), BridgeControl::objectPath(),
                                BridgeControl::serviceName(), bus);
        const QString payload = QString::fromUtf8(QJsonDocument(QJsonObject{
            {"id", QUuid::createUuid().toString(QUuid::WithoutBraces)}, {"command", "focus"}
        }).toJson(QJsonDocument::Compact));
        const auto reply = existing.call(QStringLiteral("Execute"), payload);
        if (reply.type() == QDBusMessage::ErrorMessage || reply.arguments().isEmpty()) return 1;
        return QJsonDocument::fromJson(reply.arguments()[0].toString().toUtf8()).object().value("ok").toBool() ? 0 : 1;
    }

    QQmlApplicationEngine engine;
    QObject::connect(&engine, &QQmlApplicationEngine::objectCreationFailed, &app,
                     [] { QCoreApplication::exit(1); }, Qt::QueuedConnection);
    engine.loadFromModule("StremioTV.Native", "Main");
    return app.exec();
}
