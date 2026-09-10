/*!
 * Help Me Breathe — embed loader v1. Docs: https://helpmebreath.com/embed
 *
 * Replaces its own <script> tag with a responsive iframe of /embed/v1/frame.html
 * and resizes it from the frame's hmb:resize messages. Several embeds per page
 * are fine; it never throws. v1 is frozen - breaking changes ship as v2.
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
    for (var i = 0; i < PARAMS.length; i++) {
      var value = tag.getAttribute('data-' + PARAMS[i]);
      if (value === null || value === '') continue;
      query.push(encodeURIComponent(PARAMS[i]) + '=' + encodeURIComponent(value));
    }

    var frame = document.createElement('iframe');
    // Clean URL: vercel.json sets cleanUrls, so "frame.html" would 308 first.
    frame.setAttribute('src', base + 'frame' + (query.length ? '?' + query.join('&') : ''));
    frame.setAttribute('title', 'Guided breathing exercise');
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('allow', 'screen-wake-lock');
    frame.setAttribute('data-hmb-embed', '1');
    frame.style.cssText = 'display:block;width:100%;max-width:100%;min-height:420px;border:0;background:transparent';

    attachResizeListener(origin);

    tag.parentNode.insertBefore(frame, tag);
    tag.parentNode.removeChild(tag);
  } catch (err) { /* never break the host page */ }
}());
