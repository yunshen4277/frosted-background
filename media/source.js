/* Shared, dependency-free external media URL validation. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FrostedSource = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const IMAGE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
  const VIDEO = /\.(mp4|webm)$/i;
  function invalid() { throw new Error('请输入有效的 HTTPS 媒体链接，不支持本机地址或包含账号密码的链接。'); }
  function publicHost(host) {
    host = host.toLowerCase().replace(/\.$/, '');
    if (!host || !host.includes('.') || /(?:^|\.)(localhost|local|internal|lan|home|onion)$/.test(host)) return false;
    if (/^[\d.]+$/.test(host)) {
      const parts = host.split('.').map(Number);
      if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
      const [a, b] = parts;
      return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
    }
    return !host.includes(':') && /^[a-z0-9.-]+$/.test(host) && host.split('.').every(part => part && part.length <= 63 && !part.startsWith('-') && !part.endsWith('-'));
  }
  function mediaURL(value) {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value.trim())) return invalid();
    let url;
    try { url = new URL(value.trim()); } catch { return invalid(); }
    if (url.protocol !== 'https:' || url.username || url.password || !publicHost(url.hostname)) return invalid();
    url.hash = '';
    return url;
  }
  function platformLink(url) {
    const host = url.hostname.toLowerCase();
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'].includes(host)) {
      let id = host === 'youtu.be' ? url.pathname.slice(1) : url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:embed|shorts|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
      if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) {
        const canonical = new URL('https://www.youtube.com/watch'); canonical.searchParams.set('v', id);
        const start = url.searchParams.get('t') || url.searchParams.get('start');
        if (start && /^(?:\d+h)?(?:\d+m)?\d+s?$/.test(start)) canonical.searchParams.set('t', start);
        return { type: 'platform', platform: 'YouTube', url: canonical.href };
      }
      if (/^\/(?:@[A-Za-z0-9_.-]+|channel\/[A-Za-z0-9_-]+)\/live\/?$/.test(url.pathname)) return { type: 'platform', platform: 'YouTube', url: 'https://www.youtube.com' + url.pathname };
      throw new Error('请输入 YouTube 视频、直播或 Twitch 频道链接。');
    }
    if (['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'player.twitch.tv', 'clips.twitch.tv'].includes(host)) {
      let pathname = url.pathname;
      if (host === 'clips.twitch.tv' && pathname === '/embed') {
        const clip = url.searchParams.get('clip');
        if (!clip || !/^[A-Za-z0-9_-]{1,150}$/.test(clip)) throw new Error('请输入 YouTube 视频、直播或 Twitch 频道链接。');
        pathname = '/' + clip;
      }
      if (host === 'player.twitch.tv') {
        const channel = url.searchParams.get('channel'), video = url.searchParams.get('video');
        pathname = channel && /^[A-Za-z0-9_]{1,25}$/.test(channel) ? '/' + channel : video && /^v?\d+$/.test(video) ? '/videos/' + video.replace(/^v/, '') : '';
      }
      const valid = host === 'clips.twitch.tv' ? /^\/[A-Za-z0-9_-]{1,150}$/.test(pathname)
        : /^\/(?:[A-Za-z0-9_]{1,25}|videos\/\d+|[A-Za-z0-9_]{1,25}\/clip\/[A-Za-z0-9_-]{1,150})\/?$/.test(pathname);
      if (!valid) throw new Error('请输入 YouTube 视频、直播或 Twitch 频道链接。');
      return { type: 'platform', platform: 'Twitch', url: 'https://' + (host === 'clips.twitch.tv' ? host : 'www.twitch.tv') + pathname };
    }
    return null;
  }
  function classifyLink(value, hint = 'auto') {
    if (!['auto', 'image', 'video', 'hls'].includes(hint)) return invalid();
    const url = mediaURL(value);
    const platform = platformLink(url);
    if (platform) return platform;
    const type = hint === 'auto' ? /\.m3u8$/i.test(url.pathname) ? 'hls' : IMAGE.test(url.pathname) ? 'image' : VIDEO.test(url.pathname) ? 'video' : 'auto' : hint;
    return { type, kind: type === 'hls' ? 'video' : type, url: url.href };
  }
  function normalizeRemoteSource(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'hls' || value.kind !== 'video') return invalid();
    const url = mediaURL(value.url);
    if (platformLink(url)) return invalid();
    return { type: 'hls', kind: 'video', url: url.href };
  }
  function displayName(value) {
    const url = mediaURL(value);
    let name = url.pathname.split('/').filter(Boolean).pop() || '';
    try { name = decodeURIComponent(name); } catch { /* Keep encoded label. */ }
    return url.hostname + (name ? ' / ' + name.slice(0, 100) : '');
  }
  return { mediaURL, publicHost, classifyLink, normalizeRemoteSource, displayName };
});
