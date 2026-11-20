// Wait without consuming the editor's normal click/selection events.
export function bindLongPressDrag({ document, window, canStart, start, onError,
  delay = 500, distance = 6, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null, composing = false;
  function cancel() {
    if (pending) clearTimer(pending.timer);
    pending = null;
  }
  document.addEventListener('pointerdown', event => {
    cancel();
    if (event.button !== 0 || event.isPrimary === false || composing ||
        (event.pointerType && event.pointerType !== 'mouse') ||
        event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || !canStart(event)) return;
    const gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
    gesture.timer = setTimer(() => {
      if (pending !== gesture) return;
      pending = null;
      try { Promise.resolve(start()).catch(onError); } catch (error) { onError(error); }
    }, delay);
    pending = gesture;
  }, { capture: true });
  document.addEventListener('pointermove', event => {
    if (pending && event.buttons === 0) { cancel(); return; }
    if (pending && event.pointerId === pending.id &&
        Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > distance) cancel();
  }, { capture: true });
  for (const name of ['pointerup', 'pointercancel', 'dragstart', 'scroll', 'contextmenu', 'keydown']) {
    document.addEventListener(name, cancel, { capture: true });
  }
  document.addEventListener('compositionstart', () => { composing = true; cancel(); }, { capture: true });
  document.addEventListener('compositionend', () => { composing = false; }, { capture: true });
  window.addEventListener('blur', cancel);
  return { cancel };
}
