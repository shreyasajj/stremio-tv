#pragma once

// Renders the frames of an MpvController into the Qt Quick scene graph
// (OpenGL), underneath the transparent web UI.

#include <QQuickFramebufferObject>
#include <QPointer>
#include <QtQml/qqmlregistration.h>
#include <memory>
#include "mpvcontroller.h"

class MpvItem : public QQuickFramebufferObject {
    Q_OBJECT
    QML_NAMED_ELEMENT(MpvVideo)
    Q_PROPERTY(MpvController *controller READ controller WRITE setController NOTIFY controllerChanged)
public:
    explicit MpvItem(QQuickItem *parent = nullptr);
    ~MpvItem() override;

    Renderer *createRenderer() const override;

    MpvController *controller() const { return controller_; }
    void setController(MpvController *controller);
    std::shared_ptr<MpvCore> core() const { return core_; }

signals:
    void controllerChanged();

private:
    QPointer<MpvController> controller_;
    std::shared_ptr<MpvCore> core_;
};
