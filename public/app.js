const state = {
  marketplaceName: 'KaroMall',
  products: [],
  sites: [],
  cart: loadCart(),
  search: '',
  seller: 'all',
  category: 'all',
  instantOnly: false,
  inStockOnly: true,
  sort: 'recommended',
  page: initialPage(),
  pageSize: 12
};

const els = {
  searchForm: document.getElementById('search-form'),
  searchInput: document.getElementById('search-input'),
  sellerTabs: document.getElementById('seller-tabs'),
  categoryFilter: document.getElementById('category-filter'),
  filterInstant: document.getElementById('filter-instant'),
  filterInStock: document.getElementById('filter-in-stock'),
  sortSelect: document.getElementById('sort-select'),
  catalogKicker: document.getElementById('catalog-kicker'),
  catalogTitle: document.getElementById('catalog-title'),
  resultCount: document.getElementById('result-count'),
  status: document.getElementById('status'),
  pageRange: document.getElementById('page-range'),
  pageSizeSelect: document.getElementById('page-size-select'),
  grid: document.getElementById('product-grid'),
  pagination: document.getElementById('pagination'),
  cartPanel: document.getElementById('cart-panel'),
  cartToggle: document.getElementById('cart-toggle'),
  cartClose: document.getElementById('cart-close'),
  cartCount: document.getElementById('cart-count'),
  cartItems: document.getElementById('cart-items'),
  checkoutForm: document.getElementById('checkout-form'),
  itemTotal: document.getElementById('item-total'),
  shippingTotal: document.getElementById('shipping-total'),
  orderTotal: document.getElementById('order-total'),
  productDialog: document.getElementById('product-dialog'),
  productDialogContent: document.getElementById('product-dialog-content'),
  dialogClose: document.getElementById('dialog-close'),
  orderDialog: document.getElementById('order-dialog'),
  orderDialogContent: document.getElementById('order-dialog-content'),
  orderDialogClose: document.getElementById('order-dialog-close')
};

const yen = new Intl.NumberFormat('ja-JP');
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});

init();

async function init() {
  bindEvents();
  setStatus('読み込み中...');

  try {
    const [config, catalog] = await Promise.all([
      getJson('/api/config'),
      getJson('/api/catalog')
    ]);
    state.marketplaceName = config.marketplaceName || catalog.marketplaceName || 'KaroMall';
    state.products = catalog.products || [];
    state.sites = catalog.sites || [];

    document.title = state.marketplaceName;
    document.querySelector('.brand span:last-child').textContent = state.marketplaceName;
    els.catalogKicker.textContent = state.marketplaceName;

    if (!catalog.configured) {
      setStatus('販売サイトが未設定です。.env に STORAGE_DELIVERY_SITE_ID と STORAGE_DELIVERY_SITE_ADMIN_TOKEN を設定してください。', true);
    } else if (catalog.errors?.length) {
      setStatus(catalog.errors.join(' / '), true);
    } else {
      setStatus('');
    }
  } catch (error) {
    setStatus(error.message || 'カタログを読み込めませんでした。', true);
  }

  syncCartWithProducts();
  renderAll();
}

function bindEvents() {
  els.searchForm.addEventListener('submit', event => {
    event.preventDefault();
    state.search = els.searchInput.value.trim().toLowerCase();
    resetPageAndRender();
  });

  els.searchInput.addEventListener('input', () => {
    state.search = els.searchInput.value.trim().toLowerCase();
    resetPageAndRender();
  });

  els.filterInstant.addEventListener('change', () => {
    state.instantOnly = els.filterInstant.checked;
    resetPageAndRender();
  });

  els.filterInStock.addEventListener('change', () => {
    state.inStockOnly = els.filterInStock.checked;
    resetPageAndRender();
  });

  els.sortSelect.addEventListener('change', () => {
    state.sort = els.sortSelect.value;
    resetPageAndRender();
  });

  els.pageSizeSelect.addEventListener('change', () => {
    state.pageSize = Number(els.pageSizeSelect.value) || 12;
    resetPageAndRender();
  });

  els.sellerTabs.addEventListener('click', event => {
    const button = event.target.closest('[data-seller]');
    if (!button) return;
    state.seller = button.dataset.seller;
    renderSellerTabs();
    resetPageAndRender();
  });

  els.categoryFilter.addEventListener('change', event => {
    const input = event.target.closest('[name="category"]');
    if (!input) return;
    state.category = input.value;
    resetPageAndRender();
  });

  els.grid.addEventListener('click', event => {
    const detailsButton = event.target.closest('[data-view-product]');
    const cartButton = event.target.closest('[data-add-product]');

    if (detailsButton) {
      const product = productById(detailsButton.dataset.viewProduct);
      if (product) openProductDialog(product);
      return;
    }

    if (cartButton) {
      const card = cartButton.closest('.product-card');
      const product = productById(cartButton.dataset.addProduct);
      const quantity = Number(card.querySelector('[data-quantity]').value || 1);
      if (product) addToCart(product, quantity);
    }
  });

  els.pagination.addEventListener('click', event => {
    const button = event.target.closest('[data-page]');
    if (!button || button.disabled) return;
    state.page = Number(button.dataset.page) || 1;
    renderProducts();
    document.querySelector('.catalog-head')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  els.cartToggle.addEventListener('click', () => els.cartPanel.classList.add('open'));
  els.cartClose.addEventListener('click', () => els.cartPanel.classList.remove('open'));
  els.dialogClose.addEventListener('click', () => els.productDialog.close());
  els.orderDialogClose.addEventListener('click', () => els.orderDialog.close());

  els.cartItems.addEventListener('change', event => {
    const item = event.target.closest('[data-cart-key]');
    if (!item) return;
    const key = item.dataset.cartKey;

    if (event.target.matches('[data-cart-quantity]')) {
      updateCartLine(key, { quantity: Number(event.target.value || 1) });
    } else if (event.target.matches('[data-cart-rate]')) {
      updateCartLine(key, { rateId: event.target.value });
    }
  });

  els.cartItems.addEventListener('click', event => {
    const remove = event.target.closest('[data-remove-cart]');
    if (!remove) return;
    removeCartLine(remove.dataset.removeCart);
  });

  els.checkoutForm.addEventListener('submit', checkout);
}

function renderAll() {
  renderSellerTabs();
  renderCategories();
  renderProducts();
  renderCart();
}

function renderSellerTabs() {
  const sellers = [
    { id: 'all', name: 'すべて' },
    ...state.sites.map(site => ({ id: site.id, name: site.storeName }))
  ];

  els.sellerTabs.innerHTML = sellers.map(seller => `
    <button class="tab-button ${state.seller === seller.id ? 'active' : ''}" type="button" data-seller="${escapeHtml(seller.id)}">
      ${escapeHtml(seller.name)}
    </button>
  `).join('');
}

function renderCategories() {
  const categories = [...new Set(state.products.map(categoryFor).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
  els.categoryFilter.innerHTML = [
    categoryOption('all', 'すべて', state.category === 'all'),
    ...categories.map(category => categoryOption(category, category, state.category === category))
  ].join('');
}

function categoryOption(value, label, checked) {
  return `
    <label class="filter-option">
      <input type="radio" name="category" value="${escapeHtml(value)}" ${checked ? 'checked' : ''}>
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}

function renderProducts() {
  const filtered = filteredProducts();
  const pageCount = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), pageCount);
  const startIndex = (state.page - 1) * state.pageSize;
  const pageItems = filtered.slice(startIndex, startIndex + state.pageSize);

  els.catalogTitle.textContent = state.seller === 'all'
    ? '商品一覧'
    : state.sites.find(site => site.id === state.seller)?.storeName || '商品一覧';

  if (filtered.length === 0) {
    els.grid.innerHTML = '<div class="empty-catalog">表示できる商品がありません。</div>';
    els.resultCount.textContent = '0件';
    els.pageRange.textContent = '';
    els.pagination.innerHTML = '';
    updatePageUrl();
    return;
  }

  const endIndex = Math.min(startIndex + pageItems.length, filtered.length);
  els.resultCount.textContent = `${formatNumber(filtered.length)}件`;
  els.pageRange.textContent = `${formatNumber(startIndex + 1)}-${formatNumber(endIndex)}件を表示`;
  els.grid.innerHTML = pageItems.map(productCard).join('');
  renderPagination(pageCount);
  updatePageUrl();
}

function resetPageAndRender() {
  state.page = 1;
  renderProducts();
}

function renderPagination(pageCount) {
  if (pageCount <= 1) {
    els.pagination.innerHTML = '';
    return;
  }

  const pages = paginationPages(state.page, pageCount);
  els.pagination.innerHTML = [
    paginationButton('最初', 1, state.page === 1),
    paginationButton('前へ', state.page - 1, state.page === 1),
    ...pages.map(page => page === 'gap'
      ? '<span class="page-gap">...</span>'
      : paginationButton(String(page), page, false, page === state.page)
    ),
    paginationButton('次へ', state.page + 1, state.page === pageCount),
    paginationButton('最後', pageCount, state.page === pageCount)
  ].join('');
}

function paginationPages(current, total) {
  const pages = new Set([1, total, current, current - 1, current + 1, current - 2, current + 2]);
  const sorted = [...pages]
    .filter(page => page >= 1 && page <= total)
    .sort((a, b) => a - b);
  const output = [];

  for (const page of sorted) {
    if (output.length && page - output[output.length - 1] > 1) output.push('gap');
    output.push(page);
  }
  return output;
}

function paginationButton(label, page, disabled, active = false) {
  return `
    <button
      type="button"
      class="page-button ${active ? 'active' : ''}"
      data-page="${escapeHtml(page)}"
      ${disabled ? 'disabled' : ''}
      aria-current="${active ? 'page' : 'false'}"
    >${escapeHtml(label)}</button>
  `;
}

function updatePageUrl() {
  const url = new URL(location.href);
  if (state.page > 1) url.searchParams.set('page', String(state.page));
  else url.searchParams.delete('page');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function filteredProducts() {
  const search = state.search;
  let products = state.products.filter(product => {
    if (state.seller !== 'all' && product.siteId !== state.seller) return false;
    if (state.category !== 'all' && categoryFor(product) !== state.category) return false;
    if (state.inStockOnly && product.availableQuantity <= 0) return false;
    if (state.instantOnly && !product.rates.some(rate => Number(rate.deliverySeconds) === 0)) return false;
    if (search) {
      const haystack = [
        product.title,
        product.description,
        product.itemTypeId,
        product.itemName,
        product.sellerName,
        propertySearchText(product.itemProperties)
      ].join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  products = [...products];
  if (state.sort === 'stock') {
    products.sort((a, b) => b.availableQuantity - a.availableQuantity);
  } else if (state.sort === 'shipping') {
    products.sort((a, b) => lowestShipping(a) - lowestShipping(b));
  } else if (state.sort === 'name') {
    products.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  } else {
    products.sort((a, b) => scoreProduct(b) - scoreProduct(a));
  }
  return products;
}

function productCard(product) {
  const lowest = lowestShipping(product);
  const canBuy = product.availableQuantity > 0 && product.rates.length > 0;
  const image = imageFor(product);
  return `
    <article class="product-card">
      <img class="product-image" src="${escapeHtml(image)}" alt="${escapeHtml(product.title)}" loading="lazy">
      <div class="product-body">
        <h2 class="product-title">
          <button type="button" data-view-product="${escapeHtml(product.id)}">${escapeHtml(product.title)}</button>
        </h2>
        <div class="seller">${escapeHtml(product.sellerName)} / ${escapeHtml(product.serverId)}</div>
        <div class="price-stack">
          <div class="price-line item-price"><small>価格</small><span>${formatPriceHtml(product.unitPrice)}</span></div>
          <div class="price-line shipping-price"><small>送料</small><span>${formatMoney(lowest)}</span></div>
        </div>
        ${renderPropertyBadges(product)}
        <div class="stock-line"><span>在庫 ${formatNumber(product.availableQuantity)}</span><span>最大 ${formatNumber(product.maxQuantity)}</span></div>
        <div class="muted">${escapeHtml(shortText(product.description || product.itemName || product.itemTypeId, 80))}</div>
      </div>
      <div class="product-actions">
        <input data-quantity type="number" min="1" max="${escapeHtml(Math.max(1, Math.min(product.maxQuantity, product.availableQuantity || 1)))}" value="1" aria-label="数量">
        <button type="button" data-add-product="${escapeHtml(product.id)}" ${canBuy ? '' : 'disabled'}>カートに入れる</button>
      </div>
    </article>
  `;
}

function addToCart(product, quantity) {
  const max = Math.max(1, Math.min(product.maxQuantity, product.availableQuantity));
  const safeQuantity = Math.max(1, Math.min(Number(quantity || 1), max));
  const rate = chooseDefaultRate(product);
  if (!rate) {
    setStatus('配送レートがありません。', true);
    return;
  }

  const key = `${product.siteId}:${product.itemId}`;
  const existing = state.cart.find(line => line.key === key);
  if (existing) {
    existing.quantity = Math.min(existing.quantity + safeQuantity, max);
  } else {
    state.cart.push({
      key,
      productId: product.id,
      siteId: product.siteId,
      itemId: product.itemId,
      rateId: rate.id,
      quantity: safeQuantity
    });
  }
  saveCart();
  renderCart();
  els.cartPanel.classList.add('open');
  setStatus('カートに追加しました。');
}

function renderCart() {
  syncCartWithProducts();
  els.cartCount.textContent = String(state.cart.reduce((sum, line) => sum + line.quantity, 0));

  if (state.cart.length === 0) {
    els.cartItems.innerHTML = '<div class="empty-cart">カートは空です。</div>';
    els.itemTotal.textContent = formatMoney(0);
    els.shippingTotal.textContent = formatMoney(0);
    els.orderTotal.textContent = formatMoney(0);
    return;
  }

  els.cartItems.innerHTML = state.cart.map(line => {
    const product = productById(line.productId);
    if (!product) return '';
    const max = Math.max(1, Math.min(product.maxQuantity, product.availableQuantity || 1));
    const selectedRate = product.rates.find(rate => rate.id === line.rateId);
    return `
      <article class="cart-item" data-cart-key="${escapeHtml(line.key)}">
        <img src="${escapeHtml(imageFor(product))}" alt="${escapeHtml(product.title)}">
        <div>
          <h3>${escapeHtml(product.title)}</h3>
          <div class="seller">${escapeHtml(product.sellerName)}</div>
          <div class="cart-pricing">
            <span>価格 ${formatPriceHtml(product.unitPrice)} × ${escapeHtml(line.quantity)}</span>
            <span>小計 ${formatPriceHtml(lineItemSubtotal(line))}</span>
            <span>送料 ${formatMoney(selectedRate?.shippingFee)}</span>
          </div>
          <div class="cart-controls">
            <input data-cart-quantity type="number" min="1" max="${escapeHtml(max)}" value="${escapeHtml(line.quantity)}" aria-label="数量">
            <select data-cart-rate aria-label="配送">
              ${product.rates.map(rate => `
                <option value="${escapeHtml(rate.id)}" ${rate.id === line.rateId ? 'selected' : ''}>
                  ${escapeHtml(rate.label)} / ${formatMoney(rate.shippingFee)}
                </option>
              `).join('')}
            </select>
            <button class="icon-button" type="button" data-remove-cart="${escapeHtml(line.key)}" aria-label="削除">×</button>
          </div>
        </div>
      </article>
    `;
  }).join('');

  const itemTotal = cartItemTotal();
  const shippingTotal = cartShippingTotal();
  els.itemTotal.innerHTML = formatPriceHtml(itemTotal);
  els.shippingTotal.textContent = formatMoney(shippingTotal);
  els.orderTotal.textContent = formatMoney(itemTotal + shippingTotal);
}

function updateCartLine(key, patch) {
  const line = state.cart.find(entry => entry.key === key);
  if (!line) return;
  const product = productById(line.productId);
  if (!product) return;

  if (patch.quantity !== undefined) {
    const max = Math.max(1, Math.min(product.maxQuantity, product.availableQuantity || 1));
    line.quantity = Math.max(1, Math.min(Number(patch.quantity || 1), max));
  }
  if (patch.rateId !== undefined && product.rates.some(rate => rate.id === patch.rateId)) {
    line.rateId = patch.rateId;
  }

  saveCart();
  renderCart();
}

function removeCartLine(key) {
  state.cart = state.cart.filter(line => line.key !== key);
  saveCart();
  renderCart();
}

async function checkout(event) {
  event.preventDefault();
  if (state.cart.length === 0) return;

  const formData = new FormData(els.checkoutForm);
  const body = {
    recipientName: formData.get('recipientName'),
    recipientStoreName: formData.get('recipientStoreName'),
    lines: state.cart.map(line => ({
      siteId: line.siteId,
      itemId: line.itemId,
      rateId: line.rateId,
      quantity: line.quantity
    }))
  };

  const button = els.checkoutForm.querySelector('button[type="submit"]');
  button.disabled = true;
  setStatus('注文を作成しています...');

  try {
    const result = await postJson('/api/orders', body);
    state.cart = [];
    saveCart();
    renderCart();
    setStatus('注文を作成しました。', false);
    showOrderResult(result);
  } catch (error) {
    setStatus(error.message || '注文に失敗しました。', true);
  } finally {
    button.disabled = false;
  }
}

function showOrderResult(result) {
  const checkoutUrls = result.checkoutUrls || [];
  els.orderDialogContent.innerHTML = `
    <h2>注文を作成しました</h2>
    <div class="order-list">
      ${(result.orders || []).map(order => `
        <div class="order-row">
          <strong>${escapeHtml(order.product?.title || order.siteItemId)}</strong>
          <div class="muted">注文ID: ${escapeHtml(order.id)}</div>
          <div>状態: ${escapeHtml(order.status)} / 数量: ${escapeHtml(order.quantity)}</div>
          <div>商品 ${formatPriceHtml(order.itemSubtotal)} / 送料 ${formatMoney(order.shippingFee)} / 合計 ${formatMoney(order.totalAmount)}</div>
        </div>
      `).join('')}
    </div>
    ${checkoutUrls.length ? `
      <div class="payment-links">
        ${checkoutUrls.map((url, index) => `<a href="${escapeHtml(url)}">支払いへ進む ${index + 1}</a>`).join('')}
      </div>
    ` : '<p class="muted">配送予定に入りました。</p>'}
  `;
  els.orderDialog.showModal();
}

function openProductDialog(product) {
  els.productDialogContent.innerHTML = `
    <div class="dialog-layout">
      <img src="${escapeHtml(imageFor(product))}" alt="${escapeHtml(product.title)}">
      <div>
        <h2>${escapeHtml(product.title)}</h2>
        <p class="seller">${escapeHtml(product.sellerName)} / ${escapeHtml(product.sellerOwnerName)}</p>
        <p>${escapeHtml(product.description || product.itemName || product.itemTypeId || '')}</p>
        <table class="detail-table">
          <tbody>
            <tr><th>在庫</th><td>${formatNumber(product.availableQuantity)}</td></tr>
            <tr><th>最大数</th><td>${formatNumber(product.maxQuantity)}</td></tr>
            <tr><th>価格</th><td>${formatPriceHtml(product.unitPrice)}</td></tr>
            <tr><th>種類</th><td>${escapeHtml(product.itemTypeId || '-')}</td></tr>
            ${product.iconPath ? `<tr><th>テクスチャ</th><td><code>${escapeHtml(product.iconPath)}</code></td></tr>` : ''}
            <tr><th>配送</th><td>${product.rates.map(rate => `${escapeHtml(rate.label)} / ${formatMoney(rate.shippingFee)} / ${formatDuration(rate.deliverySeconds)}`).join('<br>')}</td></tr>
          </tbody>
        </table>
        ${renderItemProperties(product)}
      </div>
    </div>
  `;
  els.productDialog.showModal();
}

function syncCartWithProducts() {
  state.cart = state.cart.filter(line => {
    const product = productById(line.productId);
    if (!product || product.availableQuantity <= 0 || product.rates.length === 0) return false;
    if (!product.rates.some(rate => rate.id === line.rateId)) line.rateId = chooseDefaultRate(product)?.id;
    line.quantity = Math.max(1, Math.min(Number(line.quantity || 1), Math.max(1, Math.min(product.maxQuantity, product.availableQuantity))));
    return Boolean(line.rateId);
  });
  saveCart();
}

function productById(id) {
  return state.products.find(product => product.id === id);
}

function chooseDefaultRate(product) {
  return [...product.rates].sort((a, b) => {
    if (Number(a.shippingFee) !== Number(b.shippingFee)) return Number(a.shippingFee) - Number(b.shippingFee);
    return Number(a.deliverySeconds) - Number(b.deliverySeconds);
  })[0];
}

function lowestShipping(product) {
  const rate = chooseDefaultRate(product);
  return Number(rate?.shippingFee || 0);
}

function scoreProduct(product) {
  return (product.availableQuantity > 0 ? 100000 : 0) - lowestShipping(product) + Math.min(product.availableQuantity, 1000);
}

function cartShippingTotal() {
  return state.cart.reduce((sum, line) => {
    const product = productById(line.productId);
    const rate = product?.rates.find(entry => entry.id === line.rateId);
    return sum + Number(rate?.shippingFee || 0);
  }, 0);
}

function cartItemTotal() {
  return state.cart.reduce((sum, line) => sum + lineItemSubtotal(line), 0);
}

function lineItemSubtotal(line) {
  const product = productById(line.productId);
  return itemPrice(product) * Number(line.quantity || 0);
}

function itemPrice(product) {
  return Math.max(0, Number(product?.unitPrice || 0));
}

function productProperties(product) {
  return product?.itemProperties && typeof product.itemProperties === 'object'
    ? product.itemProperties
    : {};
}

function renderPropertyBadges(product) {
  const properties = productProperties(product);
  const badges = [];
  const enchantments = Array.isArray(properties.enchantments) ? properties.enchantments : [];
  const potion = Array.isArray(properties.potion) ? properties.potion : [];
  const effects = Array.isArray(properties.effects) ? properties.effects : [];
  const lore = Array.isArray(properties.lore) && properties.lore.length ? properties.lore : properties.rawLore;
  const durability = properties.durability;

  if (properties.nameTag) badges.push(`名札 ${properties.nameTag}`);
  if (enchantments.length) badges.push(`エンチャ ${enchantments.slice(0, 2).map(formatEnchant).join(', ')}`);
  if (potion.length) badges.push(`ポーション ${potion.slice(0, 1).map(formatEffect).join(', ')}`);
  if (effects.length) badges.push(`効果 ${effects.slice(0, 2).map(formatEffect).join(', ')}`);
  if (durability) badges.push(`耐久 ${formatDurability(durability)}`);
  if (Array.isArray(lore) && lore.length) badges.push(`Lore ${displayValue(lore[0])}`);

  if (badges.length === 0) return '';
  return `<div class="property-badges">${badges.slice(0, 4).map(badge => `<span>${escapeHtml(shortText(badge, 42))}</span>`).join('')}</div>`;
}

function renderItemProperties(product) {
  const properties = productProperties(product);
  const rows = [];
  const enchantments = Array.isArray(properties.enchantments) ? properties.enchantments : [];
  const potion = Array.isArray(properties.potion) ? properties.potion : [];
  const effects = Array.isArray(properties.effects) ? properties.effects : [];
  const lore = Array.isArray(properties.lore) && properties.lore.length ? properties.lore : properties.rawLore;
  const durability = properties.durability;
  const book = properties.book;

  if (properties.nameTag) rows.push(propertyRow('名札', properties.nameTag));
  if (enchantments.length) rows.push(propertyRow('エンチャント', htmlLines(enchantments.map(formatEnchant)), true));
  if (potion.length) rows.push(propertyRow('ポーション', htmlLines(potion.map(formatEffect)), true));
  if (effects.length) rows.push(propertyRow('効果', htmlLines(effects.map(formatEffect)), true));
  if (durability) rows.push(propertyRow('耐久値', formatDurability(durability)));
  if (Array.isArray(lore) && lore.length) rows.push(propertyRow('Lore', htmlLines(lore.map(displayValue)), true));
  if (book && (book.title || book.author || book.pageCount || book.isSigned)) {
    rows.push(propertyRow('本', htmlLines([
      book.title ? `タイトル: ${book.title}` : '',
      book.author ? `著者: ${book.author}` : '',
      book.pageCount ? `ページ: ${book.pageCount}` : '',
      book.isSigned ? '署名済み' : ''
    ].filter(Boolean)), true));
  }
  if (Array.isArray(properties.canDestroy) && properties.canDestroy.length) {
    rows.push(propertyRow('破壊可能', htmlLines(properties.canDestroy.map(displayValue)), true));
  }
  if (Array.isArray(properties.canPlaceOn) && properties.canPlaceOn.length) {
    rows.push(propertyRow('設置可能', htmlLines(properties.canPlaceOn.map(displayValue)), true));
  }
  if (properties.keepOnDeath || properties.lockMode) {
    rows.push(propertyRow('その他', htmlLines([
      properties.keepOnDeath ? '死亡時保持' : '',
      properties.lockMode ? `ロック: ${properties.lockMode}` : ''
    ].filter(Boolean)), true));
  }

  if (rows.length === 0) return '';
  return `
    <section class="property-section">
      <h3>アイテムプロパティ</h3>
      <div class="property-list">${rows.join('')}</div>
    </section>
  `;
}

function propertyRow(label, value, htmlValue = false) {
  return `
    <div class="property-row">
      <span>${escapeHtml(label)}</span>
      <strong>${htmlValue ? value : escapeHtml(value)}</strong>
    </div>
  `;
}

function htmlLines(values) {
  return values.filter(Boolean).map(value => escapeHtml(value)).join('<br>');
}

function propertySearchText(properties) {
  if (!properties || typeof properties !== 'object') return '';
  return [
    properties.nameTag,
    ...(Array.isArray(properties.lore) ? properties.lore.map(displayValue) : []),
    ...(Array.isArray(properties.rawLore) ? properties.rawLore.map(displayValue) : []),
    ...(Array.isArray(properties.enchantments) ? properties.enchantments.map(formatEnchant) : []),
    ...(Array.isArray(properties.potion) ? properties.potion.map(formatEffect) : []),
    ...(Array.isArray(properties.effects) ? properties.effects.map(formatEffect) : []),
    properties.book?.title,
    properties.book?.author,
    properties.lockMode,
    ...(Array.isArray(properties.canDestroy) ? properties.canDestroy.map(displayValue) : []),
    ...(Array.isArray(properties.canPlaceOn) ? properties.canPlaceOn.map(displayValue) : [])
  ].filter(Boolean).join(' ');
}

function formatEnchant(enchant) {
  return `${formatMinecraftLabel(enchant?.typeId)} Lv.${formatNumber(enchant?.level || 1)}`;
}

function formatEffect(effect) {
  return [
    formatMinecraftLabel(effect?.id),
    effect?.deliveryType ? formatMinecraftLabel(effect.deliveryType) : '',
    effect?.amplifier !== null && effect?.amplifier !== undefined ? `Lv.${Number(effect.amplifier) + 1}` : '',
    formatEffectDuration(effect)
  ].filter(Boolean).join(' / ');
}

function formatDurability(durability) {
  if (durability.unbreakable) return '壊れない';
  if (durability.remaining !== null && durability.remaining !== undefined && durability.maxDurability) {
    return `残り ${formatNumber(durability.remaining)} / ${formatNumber(durability.maxDurability)}`;
  }
  if (durability.damage !== null && durability.damage !== undefined) return `ダメージ ${formatNumber(durability.damage)}`;
  return '-';
}

function formatEffectDuration(effect) {
  const seconds = Number.isSafeInteger(Number(effect?.durationSeconds))
    ? Number(effect.durationSeconds)
    : Number.isSafeInteger(Number(effect?.durationTicks))
      ? Math.round(Number(effect.durationTicks) / 20)
      : null;
  if (seconds === null) return '';
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
  return `${Math.floor(seconds / 3600)}時間${Math.floor((seconds % 3600) / 60)}分`;
}

function formatMinecraftLabel(value) {
  return String(value || '').replace(/^minecraft:/, '').replace(/^[^:]+:/, '').replace(/_/g, ' ');
}

function displayValue(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function categoryFor(product) {
  const value = product.itemTypeId || product.itemName || '';
  const raw = value.includes(':') ? value.split(':')[1] : value;
  const first = raw.split('_')[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : '';
}

function imageFor(product) {
  return product.iconUrl || fallbackImage(product);
}

function fallbackImage(product) {
  const label = (product.itemName || product.itemTypeId || product.title || 'Item').replace(/^minecraft:/, '');
  const clean = label.split(/[_\s-]+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() || '').join('') || 'IT';
  const hue = Math.abs(hashCode(product.id || product.title)) % 360;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="500" viewBox="0 0 640 500">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="hsl(${hue},62%,72%)"/>
          <stop offset="1" stop-color="hsl(${(hue + 58) % 360},58%,42%)"/>
        </linearGradient>
      </defs>
      <rect width="640" height="500" fill="#f8fafc"/>
      <rect x="96" y="58" width="448" height="360" rx="18" fill="url(#g)"/>
      <rect x="154" y="114" width="332" height="246" rx="12" fill="rgba(255,255,255,.22)"/>
      <text x="320" y="275" text-anchor="middle" font-family="Arial, sans-serif" font-size="104" font-weight="800" fill="#fff">${escapeSvg(clean)}</text>
      <text x="320" y="455" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" font-weight="700" fill="#334155">${escapeSvg(shortText(label, 28))}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function initialPage() {
  const page = Number(new URLSearchParams(location.search).get('page') || 1);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

async function getJson(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'REQUEST_FAILED');
  return data;
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'REQUEST_FAILED');
  return data;
}

function setStatus(message, isError = false) {
  els.status.textContent = message || '';
  els.status.className = `status ${isError ? 'error' : message ? 'success' : ''}`;
}

function loadCart() {
  try {
    const parsed = JSON.parse(localStorage.getItem('delivery-marketplace-cart') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCart() {
  localStorage.setItem('delivery-marketplace-cart', JSON.stringify(state.cart));
}

function formatMoney(value) {
  return usd.format(Number(value || 0));
}

function formatPriceHtml(value) {
  const amount = Number(value || 0);
  if (amount <= 0) return '<span class="free-price">無料</span>';
  return escapeHtml(formatMoney(amount));
}

function formatNumber(value) {
  return yen.format(Number(value || 0));
}

function formatDuration(secondsValue) {
  const seconds = Number(secondsValue || 0);
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}分`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}時間`;
  return `${Math.round(seconds / 86400)}日`;
}

function shortText(value, maxLength) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function escapeSvg(value) {
  return String(value ?? '').replace(/[&<>]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;'
  }[char]));
}

function hashCode(value) {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash;
}
