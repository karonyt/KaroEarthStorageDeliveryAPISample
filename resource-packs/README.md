# Marketplace Resource Packs

GitHub で `delivery-marketplace` を配布するとき、このディレクトリも一緒に含めてください。

`server.js` はここに入っているリソースパックを読み取り、商品の `iconPath` や `itemTypeId` から表示用テクスチャを解決します。追加アイテムのテクスチャを増やす場合は、リソースパックの `textures/` と必要に応じて `textures/item_texture.json` をここへ配置します。

標準の検索対象:

- `karoearth/`
- `MakeCountryResourcePack/`
- `vanilla/`

別の場所を使いたい場合は `.env` に絶対パスを指定できます。

```env
MARKETPLACE_RESOURCE_PACK_DIRS=/path/to/resource_pack_a,/path/to/resource_pack_b
```
