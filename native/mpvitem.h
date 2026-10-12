#pragma once

#include <QQuickFramebufferObject>
#include <QString>
#include <QTimer>
#include <mpv/client.h>
#include <mpv/render_gl.h>

class MpvItem final : public QQuickFramebufferObject {
    Q_OBJECT
    Q_PROPERTY(QString source READ source WRITE setSource NOTIFY sourceChanged)
    Q_PROPERTY(bool paused READ paused NOTIFY playbackChanged)
    Q_PROPERTY(double position READ position NOTIFY playbackChanged)
    Q_PROPERTY(double duration READ duration NOTIFY playbackChanged)
    Q_PROPERTY(QString codec READ codec NOTIFY playbackChanged)
    Q_PROPERTY(QString audioDevice READ audioDevice CONSTANT)
public:
    explicit MpvItem(QQuickItem *parent = nullptr);
    ~MpvItem() override;
    Renderer *createRenderer() const override;
    QString source() const { return source_; }
    void setSource(const QString &source);
    bool paused() const { return paused_; }
    double position() const { return position_; }
    double duration() const { return duration_; }
    QString codec() const { return codec_; }
    QString audioDevice() const { return audioDevice_; }
    Q_INVOKABLE void togglePause();
    Q_INVOKABLE void seekRelative(int seconds);
    Q_INVOKABLE void stop();
signals:
    void sourceChanged();
    void playbackChanged();
private:
    friend class MpvRenderer;
    mpv_handle *mpv_ = nullptr;
    QString source_;
    QString codec_;
    QString audioDevice_;
    bool paused_ = true;
    double position_ = 0;
    double duration_ = 0;
    QTimer pollTimer_;
    void refreshState();
};
