const SVG_NS = 'http://www.w3.org/2000/svg';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export const SVG_MIME = 'image/svg+xml';
export const MAX_SVG_BYTES = 1024 * 1024;
export const STATIC_SVG_HELP = 'Use a static SVG made of shapes, paths and local gradients, or export it as PNG.';

const MAX_ELEMENTS = 1200;
const MAX_DEPTH = 24;
const MAX_ATTRIBUTE_LENGTH = 48_000;
const MAX_PATH_COMMANDS = 12_000;
const MAX_LOCAL_REFERENCES = 300;
const MAX_COORDINATE = 1_000_000;

const ELEMENT_ATTRIBUTES: Record<string, readonly string[]> = {
  svg: ['width', 'height', 'viewBox', 'preserveAspectRatio', 'version'],
  g: [],
  defs: [],
  title: [],
  desc: [],
  path: ['d', 'pathLength'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'pathLength'],
  circle: ['cx', 'cy', 'r', 'pathLength'],
  ellipse: ['cx', 'cy', 'rx', 'ry', 'pathLength'],
  line: ['x1', 'x2', 'y1', 'y2', 'pathLength'],
  polyline: ['points', 'pathLength'],
  polygon: ['points', 'pathLength'],
  linearGradient: ['x1', 'x2', 'y1', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
  radialGradient: ['cx', 'cy', 'r', 'fx', 'fy', 'fr', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
  stop: ['offset', 'stop-color', 'stop-opacity'],
  clipPath: ['clipPathUnits']
};

const COMMON_ATTRIBUTES = new Set([
  'id', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'color', 'clip-path', 'clip-rule', 'vector-effect', 'display', 'visibility'
]);
const LOCAL_IRI = /^url\(\s*#([A-Za-z_][\w.-]{0,127})\s*\)$/;
const ID = /^[A-Za-z_][\w.-]{0,127}$/;
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const DIMENSION = new RegExp(`^(${NUMBER})(?:px)?$`, 'i');
const LENGTH = new RegExp(`^${NUMBER}(?:px|%)?$`, 'i');
const NUMBERS = new RegExp(NUMBER, 'g');
const PATH = /^[\s0-9.,+\-eEMmZzLlHhVvCcSsQqTtAa]+$/;
const POINTS = /^[\s0-9.,+\-eE]+$/;
const TRANSFORMS = /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([\s0-9.,+\-eE]+\)[\s,]*)+$/;
const COLOR = /^(?:[A-Za-z]+|#[0-9A-Fa-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.%, /+\-]+\))$/;
const WORDS: Record<string, RegExp> = {
  'fill-rule': /^(?:nonzero|evenodd|inherit)$/,
  'clip-rule': /^(?:nonzero|evenodd|inherit)$/,
  'stroke-linecap': /^(?:butt|round|square|inherit)$/,
  'stroke-linejoin': /^(?:miter|round|bevel|inherit)$/,
  'gradientUnits': /^(?:objectBoundingBox|userSpaceOnUse)$/,
  'clipPathUnits': /^(?:objectBoundingBox|userSpaceOnUse)$/,
  'spreadMethod': /^(?:pad|reflect|repeat)$/,
  'vector-effect': /^(?:none|non-scaling-stroke)$/,
  'display': /^(?:inline|none|inherit)$/,
  'visibility': /^(?:visible|hidden|collapse|inherit)$/,
  'preserveAspectRatio': /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)$/,
  'version': /^(?:1\.0|1\.1|2\.0)$/
};

const invalid = (): never => { throw new Error(STATIC_SVG_HELP); };
const boundedNumbers = (value: string) => [...value.matchAll(NUMBERS)].every(([number]) => Math.abs(Number(number)) <= MAX_COORDINATE);

function staticAttribute(name: string, value: string): boolean {
  if (!value || value.length > MAX_ATTRIBUTE_LENGTH) return false;
  if (name === 'id') return ID.test(value);
  if (name === 'fill' || name === 'stroke') return LOCAL_IRI.test(value) || COLOR.test(value);
  if (name === 'clip-path') return value === 'none' || LOCAL_IRI.test(value);
  if (name === 'color' || name === 'stop-color') return COLOR.test(value);
  if (Object.hasOwn(WORDS, name)) return WORDS[name].test(value);
  if (!boundedNumbers(value)) return false;
  if (name === 'd') return PATH.test(value);
  if (name === 'points' || name === 'viewBox') return POINTS.test(value);
  if (name === 'transform' || name === 'gradientTransform') return TRANSFORMS.test(value);
  if (name === 'stroke-dasharray') return value === 'none' || value.split(/[\s,]+/).every((part) => LENGTH.test(part));
  return LENGTH.test(value);
}

function dimensions(root: Element, maxEdge: number): { width: number; height: number } {
  const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0)) invalid();
  const fixed = (name: string) => Number(DIMENSION.exec(root.getAttribute(name)?.trim() || '')?.[1]);
  let w = fixed('width');
  let h = fixed('height');
  if (viewBox) {
    const ratio = viewBox[2] / viewBox[3];
    if (Number.isNaN(w)) w = Number.isNaN(h) ? viewBox[2] : h * ratio;
    if (Number.isNaN(h)) h = w / ratio;
  }
  if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h))) invalid();
  if (!viewBox) root.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const scale = maxEdge / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Validate XML in a detached document, then give the browser only a bounded, inert image blob to decode. */
export function staticSvgImage(bytes: Uint8Array, maxEdge: number): Blob {
  if (bytes.byteLength > MAX_SVG_BYTES) invalid();
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // Reject DTDs/entities and all processing instructions apart from an optional UTF-8 XML declaration.
  const xml = source.replace(/^\s*<\?xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])utf-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>/i, '');
  if (/<!(?:doctype|entity)|<\?/i.test(xml)) invalid();
  const doc = new DOMParser().parseFromString(xml, SVG_MIME);
  const root = doc.documentElement;
  if (root.localName !== 'svg' || (root.namespaceURI !== SVG_NS && root.namespaceURI !== null) || root.prefix || doc.doctype) invalid();

  const stack: { node: Element; depth: number }[] = [{ node: root, depth: 0 }];
  const ids = new Map<string, string>();
  const links: { attribute: string; id: string }[] = [];
  let count = 0;
  let pathCommands = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    const tag = node.localName;
    if (++count > MAX_ELEMENTS || depth > MAX_DEPTH || node.namespaceURI !== root.namespaceURI || node.prefix || !Object.hasOwn(ELEMENT_ATTRIBUTES, tag) || (node !== root && tag === 'svg')) invalid();
    for (const attr of node.attributes) {
      const { name, namespaceURI } = attr;
      const value = attr.value.trim();
      if (node === root && name === 'xmlns' && namespaceURI === XMLNS_NS && value === SVG_NS) continue;
      if (namespaceURI || !(COMMON_ATTRIBUTES.has(name) || ELEMENT_ATTRIBUTES[tag].includes(name)) || !staticAttribute(name, value)) invalid();
      if (name === 'd' || name === 'points') {
        pathCommands += [...value.matchAll(NUMBERS)].length;
        if (pathCommands > MAX_PATH_COMMANDS) invalid();
      }
      if (name === 'id') {
        if (ids.has(value)) invalid();
        ids.set(value, tag);
      }
      const iri = LOCAL_IRI.exec(value);
      if (iri) {
        // A gradient or clip-path may be reused by painted shapes. Prevent chained or cyclic definitions.
        if (links.length >= MAX_LOCAL_REFERENCES || node.closest('defs, clipPath, linearGradient, radialGradient')) invalid();
        links.push({ attribute: name, id: iri[1] });
      }
    }
    for (const child of node.childNodes) {
      if (child.nodeType === 1) stack.push({ node: child as Element, depth: depth + 1 });
      else if (child.nodeType !== 8 && (child.nodeType !== 3 || (child.textContent?.trim() && tag !== 'title' && tag !== 'desc'))) invalid();
    }
  }
  for (const { attribute, id } of links) {
    const target = ids.get(id);
    if (attribute === 'clip-path' ? target !== 'clipPath' : target !== 'linearGradient' && target !== 'radialGradient') invalid();
  }

  const { width, height } = dimensions(root, maxEdge);
  // XMLSerializer emits a default namespace reset for a null-namespace root. An otherwise valid
  // namespace-less vector can still be imported by setting its outer namespace on the serialized blob.
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  const serialized = new XMLSerializer().serializeToString(root);
  return new Blob([root.namespaceURI ? serialized : serialized.replace(/^<svg(?=[\s>])/, `<svg xmlns="${SVG_NS}"`)], { type: SVG_MIME });
}
