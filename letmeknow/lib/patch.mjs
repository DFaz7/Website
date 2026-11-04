// Puts freshly built nodes into a parent while changing as little as possible: where the old and new trees have the
// same shape, only text and attributes that differ are updated, so a screen reader keeps its place, a text selection
// stays put and nothing flickers. Where the shape differs, that part is replaced. Built for views without event
// listeners inside (the detail view): an old node that is kept keeps its old listeners.

function sameShape(a, b) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName;
}

function patchAttributes(a, b) {
  for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
}

function patchNode(parent, a, b) {
  if (!sameShape(a, b)) {
    parent.replaceChild(b, a);
    return;
  }
  if (a.nodeType === 3) {
    if (a.data !== b.data) a.data = b.data;
    return;
  }
  if (a.nodeType === 1) {
    patchAttributes(a, b);
    patchChildren(a, [...b.childNodes]);
  }
}

// parent's children become `nodes` (an array of nodes not in the document).
export function patchChildren(parent, nodes) {
  const old = [...parent.childNodes];
  if (old.length !== nodes.length) {
    parent.replaceChildren(...nodes);
    return;
  }
  nodes.forEach((n, i) => patchNode(parent, old[i], n));
}
