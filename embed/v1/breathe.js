/*!
 * Help Me Breathe — embed loader v1. Docs: https://helpmebreath.com/embed
 *
 * Replaces its own <script> tag with a responsive iframe of the breathing
 * widget and resizes it from the frame's hmb:resize messages. Several embeds
 * per page are fine; it never throws. v1 is frozen - breaking changes ship as v2.
 *
 * Two frame URLs, one document:
 *   - no data-wl  -> /embed/v1/frame, the static, cacheable free widget;
 *   - data-wl set -> /api/embed/frame, the same document served by a function
 *     that verifies the credential against the page it is embedded on and
 *     inlines the verdict. Every failure there is the free widget, never an
 *     error, so a host page cannot break because of a billing state.
 */
(function () {
  'use strict';

  var PARAMS = ['technique', 'duration', 'theme', 'accent', 'logo', 'brand', 'sound', 'mode', 'wl'];

  function currentScript() {
    if (document.currentScript) return document.currentScript;
    var all = document.getElementsByTagName('script');
    return all.length ? all[all.length - 1] : null;
  }

  function attachResizeListener(origin) {
    if (window.hmbEmbedResizeBound || !window.addEventListener) return;
    window.hmbEmbedResizeBound = true;
    window.addEventListener('message', function (event) {
      try {
        if (event.origin !== origin) return;
        var data = event.data;
        if (!data || data.type !== 'hmb:resize') return;
        var height = parseInt(data.height, 10);
        if (!(height > 0)) return;
        var frames = document.querySelectorAll('iframe[data-hmb-embed]');
        for (var i = 0; i < frames.length; i++) {
          if (frames[i].contentWindow === event.source) {
            frames[i].style.height = height + 'px';
            frames[i].style.minHeight = '0px';
            return;
          }
        }
      } catch (err) { /* never break the host page */ }
    }, false);
  }

  try {
    var tag = currentScript();
    if (!tag || !tag.parentNode) return;

    // Derive the origin and the frame URL from this script's own src, so a
    // preview deployment loads its own frame rather than production's.
    var src = tag.src || '';
    var base = src.replace(/breathe\.js(\?.*)?$/, '');
    if (!base) return;
    var origin = base.replace(/^(https?:\/\/[^/]+).*$/, '$1');

    var query = [];
    var whitelabel = false;
    for (var i = 0; i < PARAMS.length; i++) {
      var value = tag.getAttribute('data-' + PARAMS[i]);
      if (value === null || value === '') continue;
      if (PARAMS[i] === 'wl') whitelabel = true;
      query.push(encodeURIComponent(PARAMS[i]) + '=' + encodeURIComponent(value));
    }

    // Clean URL for the static frame: vercel.json sets cleanUrls, so
    // "frame.html" would 308 first. The function has no extension to drop.
    var frameUrl = whitelabel ? origin + '/api/embed/frame' : base + 'frame';

    var frame = document.createElement('iframe');
    frame.setAttribute('src', frameUrl + (query.length ? '?' + query.join('&') : ''));
    frame.setAttribute('title', 'Guided breathing exercise');
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('allow', 'screen-wake-lock');
    // The white-label check reads the Referer of the frame document request.
    // Pinning the policy on the iframe sends the host page's origin (never its
    // path) even when the host sets `no-referrer` site-wide; without it the
    // credential would silently verify nowhere on such a site.
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.setAttribute('data-hmb-embed', '1');
    frame.style.cssText = 'display:block;width:100%;max-width:100%;min-height:420px;border:0;background:transparent';

    attachResizeListener(origin);

    tag.parentNode.insertBefore(frame, tag);
    tag.parentNode.removeChild(tag);
  } catch (err) { /* never break the host page */ }
}());
