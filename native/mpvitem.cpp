#include "mpvitem.h"
#include <QOpenGLContext>
#include <QOpenGLFramebufferObject>
#include <QMetaObject>
#include <QDebug>
#include <QByteArray>
#include <algorithm>

namespace {
void *getProcAddress(void *, const char *name) {
    auto *context = QOpenGLContext::currentContext();
    return context ? reinterpret_cast<void *>(context->getProcAddress(name)) : nullptr;
}
void updateCallback(void *ctx) {
    // This callback may arrive on an mpv thread. Queue a GUI-thread update.
    auto *item = static_cast<MpvItem *>(ctx);
    QMetaObject::invokeMethod(item, "update", Qt::QueuedConnection);
}
}

class MpvRenderer final : public QQuickFramebufferObject::Renderer {
public:
    explicit MpvRenderer(MpvItem *item) : item_(item) {}
    ~MpvRenderer() override {
        if (context_) {
            mpv_render_context_set_update_callback(context_, nullptr, nullptr);
            mpv_render_context_free(context_);
        }
    }
    QOpenGLFramebufferObject *createFramebufferObject(const QSize &size) override {
        return new QOpenGLFramebufferObject(size);
    }
    void render() override {
        if (!item_->mpv_) return;
        if (!context_) {
            mpv_opengl_init_params gl = { getProcAddress, nullptr };
            mpv_render_param params[] = {
                { MPV_RENDER_PARAM_API_TYPE, const_cast<char *>(MPV_RENDER_API_TYPE_OPENGL) },
                { MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl },
                { MPV_RENDER_PARAM_INVALID, nullptr }
            };
            if (mpv_render_context_create(&context_, item_->mpv_, params) < 0) {
                qWarning() << "Failed to initialize embedded libmpv OpenGL renderer";
                return;
            }
            mpv_render_context_set_update_callback(context_, updateCallback, item_);
        }
        mpv_opengl_fbo fbo = { static_cast<int>(framebufferObject()->handle()),
                             framebufferObject()->width(),
                             framebufferObject()->height(), 0 };
        int flip = 1;
        mpv_render_param params[] = {
            { MPV_RENDER_PARAM_OPENGL_FBO, &fbo },
            { MPV_RENDER_PARAM_FLIP_Y, &flip },
            { MPV_RENDER_PARAM_INVALID, nullptr }
        };
        mpv_render_context_render(context_, params);
    }
private:
    MpvItem *item_;
    mpv_render_context *context_ = nullptr;
};

MpvItem::MpvItem(QQuickItem *parent) : QQuickFramebufferObject(parent) {
    mpv_ = mpv_create();
    if (!mpv_) {
        qWarning() << "Could not create mpv";
        return;
    }
    mpv_set_option_string(mpv_, "vo", "libmpv");
    // Encoded bitstream output; never mistake this setting for a guarantee of Atmos.
    mpv_set_option_string(mpv_, "ao", "alsa");
    mpv_set_option_string(mpv_, "audio-spdif", "ac3,eac3,truehd");
    const QByteArray device = qgetenv("STREMIO_TV_AUDIO_DEVICE");
    if (!device.isEmpty()) mpv_set_option_string(mpv_, "audio-device", device.constData());
    audioDevice_ = device.isEmpty() ? QStringLiteral("auto (ALSA)") : QString::fromUtf8(device);
    if (mpv_initialize(mpv_) < 0) {
        qWarning() << "libmpv initialization failed";
        mpv_terminate_destroy(mpv_);
        mpv_ = nullptr;
        return;
    }
    pollTimer_.setInterval(500);
    connect(&pollTimer_, &QTimer::timeout, this, &MpvItem::refreshState);
    pollTimer_.start();
}

MpvItem::~MpvItem() {
    pollTimer_.stop();
    // Scene graph should release its renderer before this item is destroyed.
    if (mpv_) mpv_terminate_destroy(mpv_);
}

QQuickFramebufferObject::Renderer *MpvItem::createRenderer() const {
    return new MpvRenderer(const_cast<MpvItem *>(this));
}

void MpvItem::setSource(const QString &source) {
    if (source_ == source) return;
    source_ = source;
    emit sourceChanged();
    if (!mpv_) return;
    if (source.isEmpty()) { stop(); return; }
    const QByteArray url = source.toUtf8();
    const char *args[] = { "loadfile", url.constData(), "replace", nullptr };
    mpv_command(mpv_, args);
}

void MpvItem::togglePause() {
    if (!mpv_) return;
    const char *args[] = { "cycle", "pause", nullptr };
    mpv_command(mpv_, args);
    refreshState();
}
void MpvItem::seekRelative(int seconds) {
    if (!mpv_) return;
    const QByteArray amount = QByteArray::number(seconds);
    const char *args[] = { "seek", amount.constData(), "relative", nullptr };
    mpv_command(mpv_, args);
}
void MpvItem::stop() {
    if (!mpv_) return;
    const char *args[] = { "stop", nullptr };
    mpv_command(mpv_, args);
}
void MpvItem::refreshState() {
    if (!mpv_) return;
    int paused = 1;
    double position = 0, duration = 0;
    mpv_get_property(mpv_, "pause", MPV_FORMAT_FLAG, &paused);
    mpv_get_property(mpv_, "time-pos", MPV_FORMAT_DOUBLE, &position);
    mpv_get_property(mpv_, "duration", MPV_FORMAT_DOUBLE, &duration);
    char *codec = nullptr;
    QString codecName;
    if (mpv_get_property(mpv_, "audio-codec", MPV_FORMAT_STRING, &codec) >= 0 && codec) {
        codecName = QString::fromUtf8(codec);
        mpv_free(codec);
    }
    if (paused_ != bool(paused) || position_ != position || duration_ != duration || codec_ != codecName) {
        paused_ = bool(paused);
        position_ = position;
        duration_ = duration;
        codec_ = codecName;
        emit playbackChanged();
    }
}
