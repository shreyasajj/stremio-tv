#pragma once

// Trailer previews play in YouTube's embedded player. YouTube refuses to
// play (error 153) for an embed that names no referring site, and a page
// loaded from file:// sends none, so this names the app instead, as YouTube
// asks native apps to. Only requests for the embed page itself are touched.
//
//   EmbedReferrer { profile: profile }

#include <QObject>
#include <QWebEngineUrlRequestInterceptor>
#include <QtQml/qqmlregistration.h>

class EmbedReferrer : public QWebEngineUrlRequestInterceptor {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(QObject *profile READ profile WRITE setProfile NOTIFY profileChanged)
public:
    explicit EmbedReferrer(QObject *parent = nullptr);

    QObject *profile() const { return profile_; }
    void setProfile(QObject *profile);
    void interceptRequest(QWebEngineUrlRequestInfo &info) override;

signals:
    void profileChanged();

private:
    QObject *profile_ = nullptr;
};
