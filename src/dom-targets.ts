import type { CDPSession } from 'playwright';
import type { Config } from './config.js';
import type { Diagnostic, ElementCapture, Observation, CapturedRule } from './model.js';
import { hash } from './util.js';

interface RawNode { id: string; path: string; text: string; textLength: number; requestedCSS: Observation['requestedCSS']; reasons: Diagnostic[]; }
interface RawElement { id: string; key: string | null; path: string; nodeIds: string[]; reasons: Diagnostic[]; unsupported: number; excluded: number; signature: string; }
interface RawData { nodes: RawNode[]; rules: Array<{ matched: number; elements: RawElement[]; reasons: Diagnostic[] }>; fontState: string; }
export interface Snapshot { observations: Observation[]; rules: CapturedRule[]; signature: string; }

// The function is serialized for Runtime.evaluate. No page globals or private Playwright fields.
function collect(config: Pick<Config, 'rules' | 'limits'>) {
  const nodes: Text[] = [];
  const dataNodes: RawNode[] = [];
  const canonical = new Map<Text, string>();
  const elementIds = new Map<Element, string>();
  const diag = (code: string, message: string) => ({ code, message });
  const path = (node: Node): string => {
    const parts: number[] = []; let current: Node | null = node;
    while (current?.parentNode && parts.length < 128) { parts.unshift(Array.prototype.indexOf.call(current.parentNode.childNodes, current)); current = current.parentNode; }
    return parts.join('.');
  };
  const css = (element: Element) => { const s = getComputedStyle(element); return { fontFamily: s.fontFamily.slice(0, 4096), fontSize: s.fontSize, fontWeight: s.fontWeight, fontStyle: s.fontStyle }; };
  const rect = (r: DOMRect) => [r.x, r.y, r.width, r.height].map(n => Math.round(n * 100) / 100);
  const addText = (node: Text): string | null => {
    const existing = canonical.get(node); if (existing) return existing;
    if (nodes.length >= config.limits.maxTextNodes) return null;
    const id = `t${nodes.length + 1}`; nodes.push(node); canonical.set(node, id);
    const parent = node.parentElement!; const reasons: Diagnostic[] = [];
    const value = node.textContent ?? '';
    if (!node.isConnected) reasons.push(diag('NODE_DETACHED', 'Text node is detached.'));
    if (value.length > config.limits.maxTextLength) reasons.push(diag('TEXT_LENGTH_LIMIT', 'Text exceeds the per-node limit; fingerprint covers only its captured prefix.'));
    const range = document.createRange(); range.selectNodeContents(node);
    const visibleRect = [...range.getClientRects()].some(r => r.width > 0 && r.height > 0);
    let hidden = !visibleRect;
    for (let e: Element | null = parent; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0 || s.contentVisibility === 'hidden') hidden = true; }
    if (hidden) reasons.push(diag('TEXT_HIDDEN_OR_NO_LAYOUT', 'Text has no visible layout or is hidden; no font verdict is possible.'));
    dataNodes.push({ id, path: path(node), text: value.slice(0, config.limits.maxTextLength), textLength: value.length, requestedCSS: css(parent), reasons });
    return id;
  };
  const rules = config.rules.map(rule => {
    const matches = document.querySelectorAll(rule.selector);
    const reasons: Diagnostic[] = [];
    if (matches.length > config.limits.maxMatchesPerRule) reasons.push(diag('MATCH_LIMIT', `Matched ${matches.length} elements; capture is limited to ${config.limits.maxMatchesPerRule}.`));
    const elements: RawElement[] = [];
    for (const root of [...matches].slice(0, config.limits.maxMatchesPerRule)) {
      let id = elementIds.get(root); if (!id) { id = `e${elementIds.size + 1}`; elementIds.set(root, id); }
      const nodeIds: string[] = []; const issues: Diagnostic[] = []; let unsupported = 0; let excluded = 0; let visited = 0;
      const surfaces = new Set<string>();
      const examineElement = (e: Element) => {
        if (e.shadowRoot) { unsupported++; surfaces.add('SHADOW_DOM_EXCLUDED'); }
        if (e.namespaceURI === 'http://www.w3.org/2000/svg' || ['IFRAME', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName.toUpperCase())) { unsupported++; surfaces.add('UNSUPPORTED_SURFACE'); }
        for (const pseudo of ['::before', '::after']) { const s = getComputedStyle(e, pseudo); if (s.display !== 'none' && !['none', 'normal', '""', "''", ''].includes(s.content)) { unsupported++; surfaces.add('GENERATED_CONTENT_EXCLUDED'); } }
      };
      const examineText = (n: Text) => {
        if (!n.textContent?.trim()) { excluded++; return; }
        if (n.parentElement?.closest('script,style,noscript,template')) { excluded++; return; }
        if (n.parentElement?.closest('svg,canvas,textarea,select')) { excluded++; return; }
        const nodeId = addText(n);
        if (nodeId) nodeIds.push(nodeId);
        else if (!issues.some(d => d.code === 'TEXT_NODE_LIMIT')) issues.push(diag('TEXT_NODE_LIMIT', 'Canonical text-node limit exceeded; remaining text was not measured.'));
      };
      examineElement(root);
      if (rule.scope === 'direct') { for (const n of root.childNodes) if (n.nodeType === Node.TEXT_NODE) examineText(n as Text); }
      else {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = walker.nextNode())) {
          if (++visited > config.limits.maxTextNodes * 10) { issues.push(diag('DOM_TRAVERSAL_LIMIT', 'DOM traversal budget exhausted.')); break; }
          if (n.nodeType === Node.TEXT_NODE) examineText(n as Text); else examineElement(n as Element);
        }
      }
      for (const code of surfaces) issues.push(diag(code, 'Selected content includes a surface outside the light-DOM TextNode policy.'));
      if (nodeIds.length === 0) issues.push(diag('NO_SUPPORTED_TEXT', 'No supported non-whitespace light-DOM text was captured.'));
      const key = rule.keyAttribute ? root.getAttribute(rule.keyAttribute) : root.id || null;
      const signature = JSON.stringify({ path: path(root), key, css: css(root), rect: rect(root.getBoundingClientRect()), nodes: nodeIds.map(n => { const d = dataNodes.find(d => d.id === n)!; const index = Number(n.slice(1)) - 1; const range = document.createRange(); range.selectNodeContents(nodes[index]); return [d.path, d.text, d.requestedCSS, d.reasons, rect(range.getBoundingClientRect())]; }), issues });
      elements.push({ id, key: key?.slice(0, 4096) || null, path: path(root), nodeIds, reasons: issues, unsupported, excluded, signature });
    }
    return { matched: matches.length, elements, reasons };
  });
  const fontState = JSON.stringify({ status: document.fonts.status, faces: [...document.fonts].slice(0, 2000).map(f => [f.family, f.status, f.style, f.weight]) });
  return { nodes, data: { nodes: dataNodes, rules, fontState } };
}

export async function takeSnapshot(cdp: CDPSession, config: Config): Promise<Snapshot> {
  const group = 'fontwitness-capture';
  await cdp.send('DOM.getDocument', { depth: 0 });
  const expression = `(${collect.toString()})(${JSON.stringify({ rules: config.rules, limits: config.limits })})`;
  try {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, objectGroup: group });
    if (exceptionDetails || !result.objectId) throw new Error('SELECTOR_OR_DOM_COLLECTION_FAILED');
    const { result: raw } = await cdp.send('Runtime.callFunctionOn', { objectId: result.objectId, functionDeclaration: 'function(){return this.data}', returnByValue: true });
    const data = raw.value as RawData;
    const { result: array } = await cdp.send('Runtime.callFunctionOn', { objectId: result.objectId, functionDeclaration: 'function(){return this.nodes}', objectGroup: group });
    const { result: props } = await cdp.send('Runtime.getProperties', { objectId: array.objectId!, ownProperties: true });
    const observations: Observation[] = [];
    for (const node of data.nodes) {
      const observation: Observation = { id: node.id, path: node.path, textFingerprint: hash(node.text), textLength: node.textLength, ...(config.artifacts.includeText ? { text: node.text } : {}), requestedCSS: node.requestedCSS, fonts: [], measurementStatus: 'unmeasured', reasons: [...node.reasons], provenance: { method: 'CSS.getPlatformFontsForNode', nodeType: 3 } };
      if (node.reasons.length === 0) {
        const prop = props.find(p => p.name === String(Number(node.id.slice(1)) - 1));
        try {
          if (!prop?.value?.objectId) throw new Error('NODE_RESOLUTION_FAILED');
          const { nodeId } = await cdp.send('DOM.requestNode', { objectId: prop.value.objectId });
          const { node: description } = await cdp.send('DOM.describeNode', { nodeId });
          if (description.nodeType !== 3) throw new Error('NODE_TYPE_MISMATCH');
          observation.provenance.backendNodeId = description.backendNodeId;
          const connected = await cdp.send('Runtime.callFunctionOn', { objectId: prop.value.objectId, functionDeclaration: 'function(){return this.isConnected}', returnByValue: true });
          if (!connected.result.value) throw new Error('NODE_DETACHED');
          const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
          observation.fonts = fonts.map(f => ({ familyName: f.familyName, postScriptName: f.postScriptName, isCustomFont: f.isCustomFont, glyphCount: f.glyphCount }));
          if (fonts.length > 0) observation.measurementStatus = 'measured';
          else observation.reasons.push({ code: 'EMPTY_FONT_OBSERVATION', message: 'Chromium returned no font usage; no identity was inferred.' });
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          const code = ['NODE_DETACHED', 'NODE_TYPE_MISMATCH', 'NODE_RESOLUTION_FAILED'].includes(message) ? message : 'CDP_NODE_UNAVAILABLE';
          observation.reasons.push({ code, message: 'Text-node measurement was unavailable.' });
        }
      }
      observations.push(observation);
    }
    const rules: CapturedRule[] = data.rules.map((r, i) => ({ rule: config.rules[i], matched: r.matched, reasons: r.reasons, elements: r.elements.map(e => {
      const selected = observations.filter(o => e.nodeIds.includes(o.id));
      const issues = [...e.reasons, ...selected.flatMap(o => o.reasons)];
      const partial = issues.length > 0;
      const element: ElementCapture = { id: e.id, key: e.key, path: e.path, nodeIds: e.nodeIds, textFingerprint: hash(JSON.stringify(selected.map(o => o.textFingerprint))), structureFingerprint: hash(JSON.stringify(selected.map(o => o.path.slice(e.path.length)))), signature: hash(e.signature), reasons: issues, measurementStatus: selected.length > 0 && selected.every(o => o.measurementStatus === 'measured') ? 'measured' : 'unmeasured', coverage: partial ? 'partial' : 'complete', counts: { textNodes: selected.length, measured: selected.filter(o => o.measurementStatus === 'measured').length, excluded: e.excluded, unsupported: e.unsupported } };
      return element;
    }) }));
    const signature = hash(JSON.stringify({ fontState: data.fontState, rules: rules.map(r => [r.matched, r.reasons, r.elements.map(e => e.signature)]), nodes: observations.map(o => [o.path, o.textFingerprint, o.requestedCSS, o.measurementStatus, o.fonts.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), o.reasons]) }));
    return { observations, rules, signature };
  } finally { await cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {}); }
}
