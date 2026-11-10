import { h } from '../utils/dom.js';

let tabsCount = 0;

/**
 * Tabs that switch what one panel shows (the WAI-ARIA tabs pattern, selecting as focus
 * moves). Left/Right arrows go to the previous/next tab, Home/End to the first/last.
 * Only the selected tab is a Tab stop, so Tab goes from the tabs straight into the panel.
 *
 *   const tabs = createTabs({
 *     label: 'Bookings by status',
 *     tabs: [{ id: 'upcoming', label: 'Upcoming' }, { id: 'past', label: 'Past' }],
 *     selected: 'upcoming',
 *     onSelect: (id) => renderPanel(id),   // not called for the first selection
 *   });
 *   container.append(tabs.list, tabs.panel);
 *   tabs.setCount('upcoming', 3);          // a number after the label; null hides it
 */
export function createTabs({ label, tabs, selected, onSelect }) {
  const prefix = `tabs-${++tabsCount}`;
  const panel = h('div', { class: 'tabs__panel', id: `${prefix}-panel`, role: 'tabpanel', tabindex: '0' });
  const buttons = new Map();
  const counts = new Map();

  for (const tab of tabs) {
    const count = h('span', { class: 'tabs__count', hidden: true });
    buttons.set(tab.id, h('button', {
      type: 'button', class: 'tabs__tab', role: 'tab', id: `${prefix}-${tab.id}`, 'aria-controls': panel.id,
      onClick: () => select(tab.id),
    }, tab.label, ' ', count)); // the space keeps "Upcoming 3" two words for screen readers
    counts.set(tab.id, count);
  }

  const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': label }, [...buttons.values()]);
  list.addEventListener('keydown', (event) => {
    const ids = [...buttons.keys()];
    const index = ids.indexOf(current);
    const target = {
      ArrowRight: ids[(index + 1) % ids.length],
      ArrowLeft: ids[(index - 1 + ids.length) % ids.length],
      Home: ids[0],
      End: ids[ids.length - 1],
    }[event.key];
    if (!target) return;
    event.preventDefault();
    select(target);
    buttons.get(target).focus();
  });

  let current = null;
  function mark(id) {
    current = id;
    for (const [tabId, button] of buttons) {
      button.setAttribute('aria-selected', String(tabId === id));
      button.tabIndex = tabId === id ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', buttons.get(id).id);
  }

  function select(id) {
    if (!buttons.has(id) || id === current) return;
    mark(id);
    onSelect?.(id);
  }

  mark(buttons.has(selected) ? selected : tabs[0].id);

  return {
    list,
    panel,
    select,
    get selected() {
      return current;
    },
    /** Moves keyboard focus to the selected tab, e.g. after the item that had focus disappeared. */
    focusSelected() {
      buttons.get(current).focus();
    },
    setCount(id, value) {
      const count = counts.get(id);
      count.textContent = value ?? '';
      count.hidden = value === null || value === undefined;
    },
  };
}
