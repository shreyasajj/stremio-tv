#include "embedreferrer.h"
#include <QQuickWebEngineProfile>
#include <QWebEngineUrlRequestInfo>

EmbedReferrer::EmbedReferrer(QObject *parent) : QWebEngineUrlRequestInterceptor(parent) {}

void EmbedReferrer::setProfile(QObject *profile) {
    if (profile == profile_) return;
    if (auto *old = qobject_cast<QQuickWebEngineProfile *>(profile_)) old->setUrlRequestInterceptor(nullptr);
    profile_ = profile;
    if (auto *p = qobject_cast<QQuickWebEngineProfile *>(profile_)) p->setUrlRequestInterceptor(this);
    emit profileChanged();
}

void EmbedReferrer::interceptRequest(QWebEngineUrlRequestInfo &info) {
    const QUrl url = info.requestUrl();
    const QString host = url.host();
    const bool youtube = host == QLatin1String("www.youtube-nocookie.com") || host == QLatin1String("www.youtube.com");
    if (!youtube || !url.path().startsWith(QLatin1String("/embed/"))) return;
    if (info.firstPartyUrl().scheme() != QLatin1String("file")) return;
    static const QByteArray referrer = "https://" + QByteArray(STREMIO_TV_APP_ID).toLower() + "/";
    info.setHttpHeader("Referer", referrer);
}
