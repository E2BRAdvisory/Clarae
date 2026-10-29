// Live Preview widget for a ```query block (a block replacement: the source shows
// when the cursor is inside, like the other block widgets).
import { WidgetType, type EditorView } from '@codemirror/view';
import { livePreviewContext } from '../editor/context';
import { disposeQueryBlock } from './block';

export class QueryWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  override eq(o: QueryWidget): boolean {
    return o.source === this.source;
  }
  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-lp-query';
    const ctx = view.state.facet(livePreviewContext);
    if (ctx.renderQuery) ctx.renderQuery(this.source, el);
    else el.textContent = this.source;
    return el;
  }
  override destroy(dom: HTMLElement): void {
    disposeQueryBlock(dom);
  }
  // Buttons and links inside handle their own events.
  override ignoreEvent(): boolean {
    return true;
  }
}
