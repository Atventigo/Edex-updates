// Runs in the page's own JS world (MAIN) at document_start.
// Wraps fetch and XMLHttpRequest to copy JSON responses NurtureCloud already
// receives. It reads only: it never changes a request or makes one of its own.
(() => {
  if (window.__fuaHooked) return;
  window.__fuaHooked = true;

  const TAG = "fua-capture";
  const MAX_CHARS = 5_000_000;

  const emit = (url, method, status, text) => {
    if (!text || text.length > MAX_CHARS) return;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    window.postMessage({ tag: TAG, url: new URL(url, location.href).href, method, status, body }, location.origin);
  };

  const isJson = (contentType) => /json/i.test(contentType || "");

  // Note the Authorization header NurtureCloud's own requests use, so the
  // backfill can authenticate the same way. Never captures the cookie.
  const noteAuth = (authorization) => {
    if (authorization) window.postMessage({ tag: "fua-auth", authorization }, location.origin);
  };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    try {
      const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
      noteAuth(headers.get("authorization"));
    } catch {}
    const response = await origFetch.apply(this, arguments);
    try {
      if (isJson(response.headers.get("content-type"))) {
        const method = (init && init.method) || (input instanceof Request ? input.method : "GET");
        response.clone().text().then((t) => emit(response.url, method.toUpperCase(), response.status, t), () => {});
      }
    } catch {}
    return response;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__fua = { method: String(method).toUpperCase(), url: String(url) };
    return origOpen.apply(this, arguments);
  };
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (String(name).toLowerCase() === "authorization") noteAuth(value);
    return origSetHeader.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", () => {
      try {
        if (!this.__fua || !isJson(this.getResponseHeader("content-type"))) return;
        const text = this.responseType === "" || this.responseType === "text" ? this.responseText
          : this.responseType === "json" ? JSON.stringify(this.response) : null;
        emit(this.responseURL || this.__fua.url, this.__fua.method, this.status, text);
      } catch {}
    });
    return origSend.apply(this, arguments);
  };
})();
