window.__ModuleLoader__.load({
  id: '@azhe0306/dsh-balance-widget',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ---------------------------------------------------------------
    // Account balance readout — one always-visible figure in the session
    // header, fed by the account remote. It adds no data of its own: the
    // usage numbers live on the interface's own lower edge, so the header
    // carries the amount and nothing else.
    // ---------------------------------------------------------------

    const SLOT = 'conversation.session.header.utilities';
    const ID = 'usage-skin';
    const ORDER = -20;
    const NS = 'usageSkin';

    // Visible text follows the active UI language through the locale service.
    const DICT = {
      en: {
        balance: 'Balance {balance}',
        balanceSplit: 'Balance {balance} (recharge {recharge} + bonus {bonus})',
      },
      zh: {
        balance: '当前余额 {balance}',
        balanceSplit: '当前余额 {balance}（充值 {recharge} + 赠金 {bonus}）',
      },
    };

    const CSS = `
.usage-skin-root{display:inline-flex;align-items:center;font-variant-numeric:tabular-nums;font-size:12px;line-height:20px;user-select:none;white-space:nowrap;flex:none}
.usage-skin-bal{color:var(--dsw-alias-label-primary);font-weight:500}
`;

    // A "not ready" balance read covers two different situations: the account
    // namespace is still being mounted when `apply` runs, and the page is
    // signed out. Short early retries settle the first within about a second;
    // the later rungs give a sign-in that happens while the page is open a
    // chance. After the ladder is spent the read stays absent rather than
    // polling the account service forever.
    const RETRY_DELAYS = [400, 1200, 3000, 8000, 20000];

    // `getBalance()` resolves to the RPC envelope `{ok:true,value}` |
    // `{ok:false,error}`; the payload inside is
    // `{ status:'ready', value:[{currency,balance}], bonusWallets:[…] }` (or
    // `{status:'failed'}` / null), with balance a decimal string.
    //
    // The platform splits spendable money into a recharge bucket (`value`) and
    // a bonus bucket (`bonusWallets`); an account can hold one without the
    // other, so reading only `value` silently drops a real balance. The readout
    // therefore shows the spendable total and keeps the two legs for the
    // tooltip.
    function walletIn(wallets, currency) {
      if (!Array.isArray(wallets)) return null;
      const row =
        wallets.find((w) => w && w.currency === currency && w.balance != null) ||
        wallets.find((w) => w && w.balance != null);
      if (!row) return null;
      const amount = Number(row.balance);
      if (!isFinite(amount)) return null;
      return { currency: row.currency, amount };
    }

    // `null` means "nothing trustworthy to show": signed out, a failed query,
    // or wallet rows whose balance is not a number.
    function readBalance(envelope) {
      if (!envelope || envelope.ok !== true) return null;
      const result = envelope.value;
      if (!result || result.status !== 'ready') return null;
      const recharge = walletIn(result.value, 'CNY');
      const bonus = walletIn(result.bonusWallets, 'CNY');
      if (recharge === null && bonus === null) return null;
      // Only legs of one currency are added together; the recharge leg decides
      // which currency that is, falling back to the bonus leg.
      const currency = (recharge || bonus).currency;
      const leg = (wallet) => (wallet !== null && wallet.currency === currency ? wallet.amount : 0);
      const rechargeAmount = leg(recharge);
      const bonusAmount = leg(bonus);
      const sym = currency === 'CNY' ? '\u00a5' : currency === 'USD' ? '$' : '';
      return {
        total: sym + (rechargeAmount + bonusAmount).toFixed(2),
        recharge: sym + rechargeAmount.toFixed(2),
        bonus: sym + bonusAmount.toFixed(2),
        hasBonus: bonusAmount > 0,
      };
    }

    function balanceVars(balance) {
      return { balance: balance.total, recharge: balance.recharge, bonus: balance.bonus };
    }

    // Shared balance holder: one poll for the whole page, not one per mount.
    function makeBalanceStore() {
      const listeners = new Set();
      let text = null;
      let loaded = false;
      let inflight = null;
      let retryTimer = null;
      let retries = 0;
      let disposed = false;

      const publish = (next) => {
        text = next;
        for (const fn of listeners) fn(text);
      };

      // A `null` read is not cached so a later tick can retry (the account may
      // be signed out at page load, or the call may fail transiently). A
      // successful read is cached; `force` lets the refresh timer supersede it.
      function load(read, force) {
        if (disposed || inflight !== null) return;
        if (loaded && force !== true) return;
        inflight = Promise.resolve()
          .then(() => read())
          .then((res) => {
            const next = readBalance(res);
            if (next === null) {
              // Not ready. Retry on a slower-than-steady cadence, but give up
              // after a few attempts rather than polling the account service
              // forever when there is genuinely no balance to show.
              if (retries < RETRY_DELAYS.length && retryTimer === null) {
                const wait = RETRY_DELAYS[retries];
                retries += 1;
                retryTimer = setTimeout(() => {
                  retryTimer = null;
                  load(read);
                }, wait);
              }
              return;
            }
            retries = 0;
            loaded = true;
            // A settled read is a fresh object; comparing the rendered figure
            // keeps the refresh tick from re-rendering an unchanged readout.
            if (text === null || text.total !== next.total || text.hasBonus !== next.hasBonus) {
              publish(next);
            }
          })
          .catch(() => {})
          .then(() => {
            inflight = null;
          });
      }

      return {
        subscribe(fn) {
          if (disposed) return () => {};
          listeners.add(fn);
          fn(text);
          return () => listeners.delete(fn);
        },
        peek() {
          return text;
        },
        load,
        dispose() {
          disposed = true;
          if (retryTimer !== null) {
            clearTimeout(retryTimer);
            retryTimer = null;
          }
          listeners.clear();
          // Reset cached state so a store re-subscribed after a slot
          // redeclaration re-reads rather than serving a stale figure with
          // no refresh path left.
          text = null;
          loaded = false;
          retries = 0;
        },
        revive() {
          disposed = false;
        },
      };
    }

    // The header cell renders the amount alone; the tooltip carries the
    // recharge/bonus split when a bonus leg is part of it. Nothing is rendered
    // before the first settled read, so no placeholder ever flashes.
    function BalanceReadout({ balanceStore, t }) {
      const [balance, setBalance] = React.useState(() =>
        balanceStore ? balanceStore.peek() : null,
      );

      React.useEffect(() => {
        if (!balanceStore) return undefined;
        return balanceStore.subscribe(setBalance);
      }, [balanceStore]);

      if (balance === null) return null;

      const say = (key, vars) =>
        t ? t(key, vars) : DICT.en[key].replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));
      const label = say(balance.hasBonus ? 'balanceSplit' : 'balance', balanceVars(balance));

      return h(
        'span',
        {
          className: 'usage-skin-root',
          title: label,
          'aria-label': label,
        },
        h('span', { className: 'usage-skin-bal' }, balance.total),
      );
    }

    // Build one stable entry component closing over the shared store, so the
    // slot owner reconciling its children sees the same type across renders.
    function makeBalanceEntry(balanceStore, t) {
      function BalanceEntry(props) {
        return h(BalanceReadout, { ...props, balanceStore, t });
      }
      return BalanceEntry;
    }

    return {
      // `remote.account` looks like a nested property but is a real inject key:
      // cordis's service guard refuses `ctx.remote.account` unless the nested
      // namespace was injected, which is why the shipped account settings page
      // injects both. Dropping it reads as "cannot get property "account"
      // without inject" at call time.
      inject: ['slots', 'locale', 'remote', 'remote.account'],
      apply(ctx) {
        // Localized copy for the tooltip and accessible name.
        ctx.effect(() => ctx.locale.register(NS, DICT), 'usage-skin: dictionaries');
        const t = ctx.locale.bind(NS);

        // Component-local stylesheet; removed with the fiber.
        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.plugin = '@azhe0306/dsh-balance-widget';
          tag.dataset.pluginCss = '@azhe0306/dsh-balance-widget/usage-skin.css';
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => tag.remove();
        });

        // One store for the page. Its lifetime is owned by the single effect
        // below, so the interval, the retry timer, and the cache all start and
        // stop together; a slot re-declaration only re-subscribes.
        const balanceStore = makeBalanceStore();
        // `ctx.remote.account` is guarded by cordis: the injected namespace is
        // what makes the property readable, so the guard is a defence against a
        // deployment that never mounted the namespace — a not-ready read the
        // retry ladder can pick up rather than a hard failure.
        const read = () => {
          const account = ctx.remote !== undefined ? ctx.remote.account : undefined;
          if (account === undefined || typeof account.getBalance !== 'function') {
            return Promise.reject(new Error('usage-skin: account remote is not mounted yet'));
          }
          return account.getBalance();
        };

        ctx.effect(() => {
          balanceStore.revive();
          balanceStore.load(read);
          const handle = setInterval(() => balanceStore.load(read, true), 120000);
          return () => {
            clearInterval(handle);
            balanceStore.dispose();
          };
        });

        ctx.slots.inject(SLOT, () => {
          // A redeclared slot re-registers against the same store; revive so a
          // previously disposed store serves fresh state instead of a blank.
          balanceStore.revive();
          balanceStore.load(read);
          return ctx.slots.register(
            { name: SLOT, id: ID, order: ORDER },
            // Stable component identity: `balanceStore` rides a closure, so
            // the slot owner's re-renders never remount this entry.
            makeBalanceEntry(balanceStore, t),
          );
        });
      },
    };
  },
});
