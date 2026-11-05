# Vendored HLS playback

`hls.min.js` is the unmodified production build of **hls.js 1.7.4** from
https://registry.npmjs.org/hls.js/-/hls.js-1.7.4.tgz.

The downloaded archive was verified against its npm registry SHA-512 integrity:
`sha512-3GlxGdPvT2YHvQYOt+yOzT/DEior/qJVNIylHA77kgeoBTdQQqi70GwefNEUmHQeNGyjC8U62+bruqW/Tpm+tg==`.

Upstream: https://github.com/video-dev/hls.js

License: BSD-2-Clause, reproduced in `HLS-LICENSE.txt`.
The player is bundled locally. No player scripts are loaded from a CDN.
Workers are disabled; HLS requests omit credentials. Streams must support CORS.
