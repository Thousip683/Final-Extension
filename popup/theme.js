// Presentation-only: swaps the popup's color palette. No form logic here.
(function () {
  var KEY = 'eg-theme';
  var root = document.documentElement;

  function apply(name) {
    if (name && name !== 'civic') root.setAttribute('data-theme', name);
    else root.removeAttribute('data-theme');
    var btns = document.querySelectorAll('.theme-swatch');
    for (var i = 0; i < btns.length; i++) {
      var active = btns[i].getAttribute('data-theme-name') === (name || 'sand');
      btns[i].classList.toggle('is-active', active);
      btns[i].setAttribute('aria-checked', active ? 'true' : 'false');
    }
  }

  function load(cb) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([KEY], function (r) { cb((r && r[KEY]) || 'sand'); });
        return;
      }
    } catch (e) {}
    var v = 'sand';
    try { v = localStorage.getItem(KEY) || 'sand'; } catch (e) {}
    cb(v);
  }

  function save(name) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        var o = {}; o[KEY] = name; chrome.storage.local.set(o); return;
      }
    } catch (e) {}
    try { localStorage.setItem(KEY, name); } catch (e) {}
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.theme-swatch') : null;
    if (!btn) return;
    var name = btn.getAttribute('data-theme-name');
    apply(name);
    save(name);
  });

  load(apply);
})();
