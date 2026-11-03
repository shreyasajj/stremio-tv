#include "phonesetup.h"
#include "third_party/qrcodegen/qrcodegen.hpp"
#include <QBuffer>
#include <QImage>
#include <QNetworkDatagram>
#include <QNetworkInterface>
#include <QPointer>
#include <QRandomGenerator>
#include <QTcpServer>
#include <QTcpSocket>
#include <QUdpSocket>
#include <QUrlQuery>
#include <memory>

namespace {
constexpr quint16 kPreferredPort = 8765;
constexpr int kLifetimeMs = 5 * 60 * 1000;
constexpr int kMaxRequestBytes = 16 * 1024;
constexpr int kMaxBadRequests = 20;
const char *const kHaService = "_home-assistant._tcp.local";

// Private, link-local and loopback addresses: the setup page answers on the
// LAN only, even if the box happens to be reachable from further away.
bool isLanAddress(QHostAddress a) {
    bool v4 = false;
    const quint32 ip = a.toIPv4Address(&v4); // also unwraps ::ffff:a.b.c.d
    if (v4) {
        auto in = [ip](quint32 net, int bits) { return (ip >> (32 - bits)) == (net >> (32 - bits)); };
        return in(0x7F000000, 8) || in(0x0A000000, 8) || in(0xAC100000, 12) || in(0xC0A80000, 16)
            || in(0xA9FE0000, 16);
    }
    if (a.isLoopback()) return true;
    const Q_IPV6ADDR v6 = a.toIPv6Address();
    return (v6[0] & 0xFE) == 0xFC || (v6[0] == 0xFE && (v6[1] & 0xC0) == 0x80);
}

QString lanAddress() {
    QString fallback;
    for (const QNetworkInterface &iface : QNetworkInterface::allInterfaces()) {
        const auto flags = iface.flags();
        if (!(flags & QNetworkInterface::IsUp) || !(flags & QNetworkInterface::IsRunning)
            || (flags & QNetworkInterface::IsLoopBack)) continue;
        for (const QNetworkAddressEntry &entry : iface.addressEntries()) {
            const QHostAddress ip = entry.ip();
            if (ip.protocol() != QAbstractSocket::IPv4Protocol) continue;
            if (isLanAddress(ip)) return ip.toString();
            if (fallback.isEmpty()) fallback = ip.toString();
        }
    }
    return fallback.isEmpty() ? QStringLiteral("127.0.0.1") : fallback;
}

QString oneTimeCode() {
    static const char alphabet[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
    QString code;
    for (int i = 0; i < 6; i++) code += QLatin1Char(alphabet[QRandomGenerator::system()->bounded(32)]);
    return code;
}

QString qrPngDataUrl(const QString &text) {
    using qrcodegen::QrCode;
    const QrCode qr = QrCode::encodeText(text.toUtf8().constData(), QrCode::Ecc::MEDIUM);
    constexpr int border = 2, scale = 8;
    const int size = (qr.getSize() + 2 * border) * scale;
    QImage img(size, size, QImage::Format_Grayscale8);
    img.fill(255);
    for (int y = 0; y < size; y++) {
        uchar *line = img.scanLine(y);
        for (int x = 0; x < size; x++) {
            if (qr.getModule(x / scale - border, y / scale - border)) line[x] = 0;
        }
    }
    QByteArray png;
    QBuffer buffer(&png);
    buffer.open(QIODevice::WriteOnly);
    img.save(&buffer, "PNG");
    return QStringLiteral("data:image/png;base64,") + QString::fromLatin1(png.toBase64());
}

QByteArray htmlEscape(const QString &s) {
    return s.toHtmlEscaped().replace(QLatin1Char('\''), QStringLiteral("&#39;")).toUtf8();
}

void reply(QTcpSocket *socket, int status, const QByteArray &type, const QByteArray &body) {
    static const QHash<int, QByteArray> reasons {
        { 200, "OK" }, { 400, "Bad Request" }, { 403, "Forbidden" }, { 404, "Not Found" },
        { 405, "Method Not Allowed" }, { 409, "Conflict" }, { 413, "Payload Too Large" },
    };
    QByteArray head = "HTTP/1.1 " + QByteArray::number(status) + ' ' + reasons.value(status, "Error") + "\r\n";
    head += "Content-Type: " + type + "\r\n";
    head += "Content-Length: " + QByteArray::number(body.size()) + "\r\n";
    head += "Cache-Control: no-store\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\n";
    head += "Connection: close\r\n\r\n";
    socket->write(head + body);
    socket->disconnectFromHost();
}

QByteArray json(const QVariantMap &map) {
    QByteArray out = "{";
    for (auto it = map.begin(); it != map.end(); ++it) {
        if (out.size() > 1) out += ',';
        out += '"' + it.key().toUtf8() + "\":";
        if (it.value().typeId() == QMetaType::Bool) out += it.value().toBool() ? "true" : "false";
        else out += '"' + it.value().toString().toUtf8().replace('\\', "\\\\").replace('"', "\\\"") + '"';
    }
    return out + '}';
}

const char kPageNotFound[] =
    "<!doctype html><meta name=viewport content='width=device-width'><title>Stremio TV</title>"
    "<body style='font:18px system-ui;background:#07080c;color:#f5f6fa;padding:24px'>"
    "<h1>Link expired</h1><p>On the TV, open Settings &rarr; Home Assistant &rarr; Set up with phone "
    "and scan the new code.</p>";

// ---- mDNS: one-shot "legacy unicast" query (RFC 6762 §6.7) -----------------
// Sent from an ordinary port, so responders answer us directly and nothing
// has to share port 5353 with the system's mDNS daemon.

QByteArray mdnsQuery() {
    QByteArray q("\0\0\0\0\0\1\0\0\0\0\0\0", 12); // id, flags, 1 question
    for (const QByteArray &label : QByteArray(kHaService).split('.')) {
        q += char(label.size());
        q += label;
    }
    q += QByteArray("\0\0\x0c\0\1", 5); // root, type PTR, class IN
    return q;
}

bool readName(const QByteArray &p, int &pos, QString &out) {
    QStringList labels;
    int i = pos, jumps = 0;
    bool jumped = false;
    for (;;) {
        if (i >= p.size()) return false;
        const quint8 len = quint8(p[i]);
        if ((len & 0xC0) == 0xC0) { // compression pointer
            if (i + 1 >= p.size() || ++jumps > 16) return false;
            if (!jumped) pos = i + 2;
            jumped = true;
            i = ((len & 0x3F) << 8) | quint8(p[i + 1]);
            continue;
        }
        if (len == 0) {
            if (!jumped) pos = i + 1;
            break;
        }
        if (i + 1 + len > p.size()) return false;
        labels << QString::fromUtf8(p.mid(i + 1, len));
        i += 1 + len;
    }
    out = labels.join(QLatin1Char('.'));
    return true;
}

quint16 be16(const QByteArray &p, int i) { return quint16((quint8(p[i]) << 8) | quint8(p[i + 1])); }

// HA's address from an answer to our query: its A record, or the sender.
QString parseMdnsAnswer(const QByteArray &p, const QHostAddress &sender) {
    if (p.size() < 12 || !(quint8(p[2]) & 0x80)) return QString();
    const int questions = be16(p, 4);
    const int records = be16(p, 6) + be16(p, 8) + be16(p, 10);
    int pos = 12;
    QString name;
    for (int i = 0; i < questions; i++) {
        if (!readName(p, pos, name)) return QString();
        pos += 4;
    }
    bool isHa = false;
    QString address;
    for (int i = 0; i < records; i++) {
        if (!readName(p, pos, name) || pos + 10 > p.size()) return QString();
        const quint16 type = be16(p, pos);
        const int length = be16(p, pos + 8);
        pos += 10;
        if (pos + length > p.size()) return QString();
        if (type == 12 && name.compare(QLatin1String(kHaService), Qt::CaseInsensitive) == 0) isHa = true;
        if (type == 1 && length == 4 && address.isEmpty()) {
            address = QHostAddress(quint32(be16(p, pos)) << 16 | be16(p, pos + 2)).toString();
        }
        pos += length;
    }
    if (!isHa) return QString();
    if (!address.isEmpty()) return address;
    bool v4 = false;
    const quint32 ip = sender.toIPv4Address(&v4);
    return v4 ? QHostAddress(ip).toString() : sender.toString();
}
} // namespace

PhoneSetup::PhoneSetup(QObject *parent) : QObject(parent), server_(new QTcpServer(this)) {
    expiry_.setSingleShot(true);
    connect(&expiry_, &QTimer::timeout, this, [this] {
        stop();
        emit event({ { "phase", "expired" } });
    });
    connect(server_, &QTcpServer::newConnection, this, &PhoneSetup::onConnection);
}

PhoneSetup::~PhoneSetup() = default;

QVariantMap PhoneSetup::start(const MqttSettings &current) {
    current_ = current;
    code_ = oneTimeCode();
    badRequests_ = 0;
    if (!server_->isListening()
        && !server_->listen(QHostAddress::Any, kPreferredPort) && !server_->listen(QHostAddress::Any, 0)) {
        return { { "error", QStringLiteral("Could not start the setup page: %1").arg(server_->errorString()) } };
    }
    expiry_.start(kLifetimeMs);
    queryMdns();
    QTimer::singleShot(1000, this, &PhoneSetup::queryMdns);
    QTimer::singleShot(3000, this, &PhoneSetup::queryMdns);
    const QString url = QStringLiteral("http://%1:%2/setup?code=%3").arg(lanAddress()).arg(server_->serverPort()).arg(code_);
    return { { "url", url }, { "code", code_ }, { "qrPng", qrPngDataUrl(url) } };
}

void PhoneSetup::stop() {
    expiry_.stop();
    server_->close(); // open sockets (a test in flight) still get their answer
    code_.clear();
}

void PhoneSetup::onConnection() {
    while (QTcpSocket *socket = server_->nextPendingConnection()) {
        connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
        if (!isLanAddress(socket->peerAddress())) {
            reply(socket, 403, "text/plain", "Only reachable from your home network");
            continue;
        }
        // A request that never completes is dropped.
        QTimer::singleShot(30000, socket, [socket] { socket->abort(); });
        auto buffer = std::make_shared<QByteArray>();
        auto answered = std::make_shared<bool>(false);
        connect(socket, &QTcpSocket::readyRead, this, [this, socket, buffer, answered] {
            if (*answered) return;
            buffer->append(socket->readAll());
            const int headerEnd = buffer->indexOf("\r\n\r\n");
            if (buffer->size() > kMaxRequestBytes) {
                *answered = true;
                reply(socket, 413, "text/plain", "Too large");
                return;
            }
            if (headerEnd < 0) return;
            const QList<QByteArray> lines = buffer->left(headerEnd).split('\n');
            const QList<QByteArray> request = lines.value(0).trimmed().split(' ');
            qsizetype length = 0;
            for (const QByteArray &line : lines) {
                if (line.toLower().startsWith("content-length:")) length = line.mid(15).trimmed().toLongLong();
            }
            if (length < 0 || headerEnd + 4 + length > kMaxRequestBytes) length = 0;
            if (buffer->size() < headerEnd + 4 + length) return;
            const QByteArray body = buffer->mid(headerEnd + 4, length);
            *answered = true;
            handle(socket, request.value(0), request.value(1), body);
        });
    }
}

void PhoneSetup::handle(QTcpSocket *socket, const QByteArray &method, const QByteArray &target, const QByteArray &body) {
    const QUrl url(QString::fromUtf8(target));
    if (url.path() != QLatin1String("/setup")) {
        reply(socket, 404, "text/plain", "Not found");
        return;
    }
    const QString code = QUrlQuery(url).queryItemValue(QStringLiteral("code")).trimmed().toUpper();
    if (code_.isEmpty() || code != code_) {
        reply(socket, 403, "text/html; charset=utf-8", kPageNotFound);
        if (!code_.isEmpty() && ++badRequests_ >= kMaxBadRequests) {
            stop();
            emit event({ { "phase", "expired" } });
        }
        return;
    }
    if (method == "GET") reply(socket, 200, "text/html; charset=utf-8", formPage());
    else if (method == "POST") submit(socket, body);
    else reply(socket, 405, "text/plain", "Method not allowed");
}

void PhoneSetup::submit(QTcpSocket *socket, const QByteArray &body) {
    if (testing_) {
        reply(socket, 409, "application/json", json({ { "ok", false }, { "error", "Still testing the last attempt" } }));
        return;
    }
    // application/x-www-form-urlencoded: '+' is a space.
    QByteArray form = body;
    form.replace('+', "%20");
    const QUrlQuery query(QString::fromUtf8(form));
    auto field = [&](const char *name) {
        return query.queryItemValue(QLatin1String(name), QUrl::FullyDecoded);
    };
    MqttSettings s = current_;
    s.host = field("host").trimmed();
    const int port = field("port").trimmed().toInt();
    s.port = port > 0 && port < 65536 ? port : 1883;
    s.username = field("username").trimmed();
    s.password = field("password");
    if (s.host.isEmpty()) {
        reply(socket, 400, "application/json", json({ { "ok", false }, { "error", "Enter the broker address" } }));
        return;
    }

    testing_ = true;
    emit event({ { "phase", "testing" } });
    QPointer<QTcpSocket> client(socket);
    HomeAssistant::runTest(s, this, [this, client, s](const QString &error) {
        testing_ = false;
        const bool ok = error.isEmpty();
        if (client) reply(client, 200, "application/json", json({ { "ok", ok }, { "error", error } }));
        emit event({
            { "phase", "done" },
            { "ok", ok },
            { "error", error },
            { "settings", QVariantMap {
                { "host", s.host }, { "port", s.port }, { "username", s.username }, { "password", s.password } } },
        });
        if (ok) stop();
    });
}

QByteArray PhoneSetup::formPage() const {
    const QString host = current_.host.isEmpty() ? discoveredHost_ : current_.host;
    QByteArray page = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stremio TV · Home Assistant</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px 16px 48px; background: #07080c; color: #f5f6fa;
         font: 17px/1.4 system-ui, sans-serif; }
  main { max-width: 440px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 6px; }
  p { color: #a4a9bb; margin: 0 0 20px; }
  label { display: block; font-weight: 600; margin: 16px 0 6px; }
  input { box-sizing: border-box; width: 100%; padding: 12px 14px; font: inherit; color: inherit;
          background: rgba(255,255,255,.07); border: 2px solid rgba(255,255,255,.1); border-radius: 12px; }
  input:focus { outline: none; border-color: #7c5cff; }
  .hint { color: #6f7488; font-size: 14px; margin-top: 4px; }
  button { width: 100%; margin-top: 28px; padding: 14px; font: inherit; font-weight: 700; color: #fff;
           background: #7c5cff; border: 0; border-radius: 999px; }
  button:disabled { opacity: .6; }
  #status { margin-top: 20px; padding: 14px; border-radius: 12px; display: none; }
  #status.ok { display: block; background: rgba(60,190,120,.18); }
  #status.error { display: block; background: rgba(239,91,91,.18); }
  #status.busy { display: block; background: rgba(255,255,255,.07); }
</style></head>
<body><main>
<h1>Stremio TV &rarr; Home Assistant</h1>
<p>Enter your MQTT broker's login. With the Mosquitto add-on, the broker runs on your Home Assistant host.</p>
<form id="f" autocomplete="off">
  <label for="host">Broker address</label>
  <input id="host" name="host" required autocapitalize="off" spellcheck="false" placeholder="192.168.1.10" value="@HOST@">
  <label for="port">Port</label>
  <input id="port" name="port" inputmode="numeric" pattern="[0-9]*" value="@PORT@">
  <label for="username">Username</label>
  <input id="username" name="username" autocapitalize="off" spellcheck="false" value="@USER@">
  <div class="hint">A dedicated broker user, e.g. stremio-tv, is easiest to revoke later.</div>
  <label for="password">Password</label>
  <input id="password" name="password" type="password">
  <button id="go" type="submit">Connect</button>
</form>
<div id="status"></div>
</main>
<script>
const form = document.getElementById('f');
const status = document.getElementById('status');
const go = document.getElementById('go');
function show(kind, text) { status.className = kind; status.textContent = text; }
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  go.disabled = true;
  show('busy', 'Testing the connection…');
  try {
    const res = await fetch(location.href, { method: 'POST', body: new URLSearchParams(new FormData(form)) });
    const r = await res.json();
    if (r.ok) {
      show('ok', 'Connected. Stremio TV is now sending to Home Assistant; you can close this page.');
      form.style.display = 'none';
      return;
    }
    show('error', r.error || 'Could not connect');
  } catch (err) {
    show('error', 'The TV stopped answering. Open the setup screen on the TV again.');
  }
  go.disabled = false;
});
</script>
</body></html>
)HTML";
    page.replace("@HOST@", htmlEscape(host));
    page.replace("@PORT@", QByteArray::number(current_.port));
    page.replace("@USER@", htmlEscape(current_.username));
    return page;
}

void PhoneSetup::queryMdns() {
    if (!server_->isListening() || !discoveredHost_.isEmpty()) return;
    if (!mdns_) {
        mdns_ = new QUdpSocket(this);
        if (!mdns_->bind(QHostAddress::AnyIPv4, 0)) return;
        connect(mdns_, &QUdpSocket::readyRead, this, &PhoneSetup::readMdns);
    }
    mdns_->writeDatagram(mdnsQuery(), QHostAddress(QStringLiteral("224.0.0.251")), 5353);
}

void PhoneSetup::readMdns() {
    while (mdns_->hasPendingDatagrams()) {
        const QNetworkDatagram d = mdns_->receiveDatagram(4096);
        const QString host = parseMdnsAnswer(d.data(), d.senderAddress());
        if (!host.isEmpty() && discoveredHost_.isEmpty()) discoveredHost_ = host;
    }
}
