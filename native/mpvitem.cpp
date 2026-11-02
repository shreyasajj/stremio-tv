#include "mpvitem.h"
#include <QDebug>
#include <QMetaObject>
#include <QOpenGLContext>
#include <QOpenGLFramebufferObject>
#include <QQuickOpenGLUtils>
#include <mpv/render_gl.h>

namespace {

void *getProcAddress(void *, const char *name) {
    auto *context = QOpenGLContext::currentContext();
    return context ? reinterpret_cast<void *>(context->getProcAddress(name)) : nullptr;
}

// Called from an mpv thread when a new frame is ready.
void onUpdate(void *ctx) {
    auto *core = static_cast<MpvCore *>(ctx);
    std::lock_guard<std::mutex> lock(core->mutex);
    if (core->item) QMetaObject::invokeMethod(core->item, "update", Qt::QueuedConnection);
}

} // namespace

class MpvRenderer final : public QQuickFramebufferObject::Renderer {
public:
    ~MpvRenderer() override {
        if (context_) {
            mpv_render_context_set_update_callback(context_, nullptr, nullptr);
            mpv_render_context_free(context_);
        }
    }

    // Runs on the render thread while the GUI thread is blocked.
    void synchronize(QQuickFramebufferObject *item) override {
        if (!core_) core_ = static_cast<MpvItem *>(item)->core();
    }

    QOpenGLFramebufferObject *createFramebufferObject(const QSize &size) override {
        return new QOpenGLFramebufferObject(size);
    }

    void render() override {
        if (failed_ || !core_ || !core_->handle) return;
        if (!context_) {
            mpv_opengl_init_params gl = { getProcAddress, nullptr };
            mpv_render_param params[] = {
                { MPV_RENDER_PARAM_API_TYPE, const_cast<char *>(MPV_RENDER_API_TYPE_OPENGL) },
                { MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl },
                { MPV_RENDER_PARAM_INVALID, nullptr },
            };
            const int err = mpv_render_context_create(&context_, core_->handle, params);
            if (err < 0) {
                qWarning() << "Failed to initialize the libmpv OpenGL renderer:" << mpv_error_string(err);
                context_ = nullptr;
                failed_ = true;
                // Tell the UI: otherwise audio plays over a blank screen.
                std::lock_guard<std::mutex> lock(core_->mutex);
                if (core_->controller) {
                    QMetaObject::invokeMethod(core_->controller, "reportRenderError", Qt::QueuedConnection,
                        Q_ARG(QString, QStringLiteral("libmpv could not start OpenGL video output (%1)")
                                           .arg(QString::fromUtf8(mpv_error_string(err)))));
                }
                return;
            }
            mpv_render_context_set_update_callback(context_, onUpdate, core_.get());
        }
        QOpenGLFramebufferObject *fbo = framebufferObject();
        mpv_opengl_fbo target = { static_cast<int>(fbo->handle()), fbo->width(), fbo->height(), 0 };
        int flipY = 0;
        mpv_render_param params[] = {
            { MPV_RENDER_PARAM_OPENGL_FBO, &target },
            { MPV_RENDER_PARAM_FLIP_Y, &flipY },
            { MPV_RENDER_PARAM_INVALID, nullptr },
        };
        mpv_render_context_render(context_, params);
        QQuickOpenGLUtils::resetOpenGLState();
    }

private:
    std::shared_ptr<MpvCore> core_;
    mpv_render_context *context_ = nullptr;
    bool failed_ = false;
};

MpvItem::MpvItem(QQuickItem *parent) : QQuickFramebufferObject(parent) {
    // mpv renders top-down into the FBO; Qt Quick samples it bottom-up.
    setMirrorVertically(true);
}

MpvItem::~MpvItem() {
    if (core_) {
        std::lock_guard<std::mutex> lock(core_->mutex);
        core_->item = nullptr;
    }
}

void MpvItem::setController(MpvController *controller) {
    if (controller_ == controller) return;
    if (core_) {
        std::lock_guard<std::mutex> lock(core_->mutex);
        core_->item = nullptr;
    }
    controller_ = controller;
    core_ = controller ? controller->core() : nullptr;
    if (core_) {
        std::lock_guard<std::mutex> lock(core_->mutex);
        core_->item = this;
    }
    emit controllerChanged();
    update();
}

QQuickFramebufferObject::Renderer *MpvItem::createRenderer() const {
    return new MpvRenderer();
}
