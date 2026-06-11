# KaroEarth Delivery Marketplace

storage-delivery-api を使った Amazon 風の購入サイトです。商品一覧、検索、販売店/カテゴリ絞り込み、カート、配送レート選択、注文作成までを含みます。

## 起動

```bash
cd KaroEarthStorageDeliveryAPISample
npm start
```

標準では `http://localhost:3000` で起動します。

## アイテム表示

商品データに含まれる耐久値、エンチャント、ポーション効果、カスタム名、lore、アイコン用テクスチャを商品カードと詳細画面へ表示します。

テクスチャは `resource-packs/` を同梱して配布できます。標準では次の順番で検索します。

- `resource-packs/karoearth`
- `resource-packs/MakeCountryResourcePack`
- `resource-packs/vanilla`

別のリソースパックを使う場合は、絶対パスをカンマ区切りで指定できます。

```env
MARKETPLACE_RESOURCE_PACK_DIRS=/path/to/resource_pack_a,/path/to/resource_pack_b
```

## APIキーの発行場所

[`account-link`](https://mclink.karon.jp/) の `/me` にログインして、Minecraft 連携済み状態で **SHOP API 管理** を開きます。

1. 販売サイトを作成
2. 表示された `siteId` とサイト専用APIキーを控える
3. 必要なら仮想ストレージ在庫から公開アイテムと送料レートを追加
4. このサイトの `.env` に設定

```env
STORAGE_DELIVERY_SITE_ID=sds_xxx
STORAGE_DELIVERY_SITE_ADMIN_TOKEN=sdt_xxx
STORAGE_DELIVERY_SITE_LABEL=Seller Shop
```

複数店舗をまとめる場合は JSON で設定できます。

```env
MARKETPLACE_SITES=[{"siteId":"sds_xxx","adminToken":"sdt_xxx","label":"Seller Shop"},{"siteId":"sds_yyy","adminToken":"sdt_yyy","label":"Other Shop"}]
```

## セキュリティ

- サイト専用APIキーはサーバー側だけで使い、ブラウザへ返しません。
- 注文時はこのサーバーが `POST /api/admin/sites/<siteId>/order-signatures` を呼び、署名済みで `POST /api/sites/<siteId>/orders` を作成します。
- `siteId` は `.env` に登録された店舗だけ許可します。
- 注文前に公開商品、配送レート、在庫数、数量上限を配送APIから再確認します。
- 注文APIにはIP単位の簡易レート制限があります。
- checkout の `successUrl` / `cancelUrl` は `PUBLIC_BASE_URL` 配下に固定しています。

## 関連サービス

- `storage-delivery-api`: 公開商品、送料レート、注文作成、署名API
- `virtual-storage`: 実在庫の保管、エスクロー、配送
- [`account-link`](https://mclink.karon.jp/): 販売サイトとサイト専用APIキーの発行UI

## 動作中のサンプル
https://karozon.karon.jp/
