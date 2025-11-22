# Integration Tests

## File Upload Integration Test

This integration test verifies that the file upload functionality works correctly with Shopify's API.

### Prerequisites

1. **Test Image**: A test image is automatically created at `tests/fixtures/test-image.png`
2. **Shopify Access Token**: You need an OAuth access token (not the client secret)
3. **Shop Domain**: Your Shopify shop domain (e.g., `your-shop.myshopify.com`)

### Getting a Shopify Access Token

The Shopify Admin API requires an OAuth access token, not the client secret. The easiest way to get one for testing is:

#### Method 1: Create a Custom App in Shopify Admin (Recommended - Easiest)

1. **Log in to your development store admin**
   - Go to `https://your-shop.myshopify.com/admin`
   - Or use a development store from your Shopify Partners account

2. **Enable custom app development**
   - Go to **Settings** → **Apps and sales channels**
   - Click **"Develop apps"** (you may need to enable custom app development first)

3. **Create a new app**
   - Click **"Create an app"**
   - Name it (e.g., "Bynder Integration Test")
   - Click **"Create app"**

4. **Configure Admin API scopes** ⚠️ **CRITICAL STEP**
   - Click **"Configure Admin API scopes"**
   - **You MUST select these scopes:**
     - ✅ `read_files` - Required to read file information
     - ✅ `write_files` - **REQUIRED** for `stagedUploadsCreate` mutation
     - ✅ `read_metaobjects` - Required to read metafields
     - ✅ `write_metaobjects` - Required to write metafields
   - Click **"Save"**
   - ⚠️ **Important**: If you already installed the app before adding scopes, you need to **reinstall** it for the new scopes to take effect!

5. **Install the app**
   - Click **"Install app"**
   - Confirm installation

6. **Get the access token**
   - Click **"Reveal token once"**
   - **Copy the token immediately** (it won't be shown again!)

#### Method 2: Using Your Existing App (If Already Installed)

If your app is already installed on a development store:
1. Go to your Shopify Partners dashboard
2. Select your app → **"Test your app"**
3. Select a development store
4. The access token is stored in your app's session after OAuth
5. You can extract it from your database or session storage

### Running the Test

Once you have the access token and shop domain, set environment variables:

**On Linux/Mac:**
```bash
export SHOPIFY_SHOP_DOMAIN="your-shop.myshopify.com"
export SHOPIFY_ACCESS_TOKEN="shpat_xxxxxxxxxxxxxxxxxxxxx"
pnpm test files.integration.test.ts
```

**On Windows PowerShell:**
```powershell
$env:SHOPIFY_SHOP_DOMAIN="your-shop.myshopify.com"
$env:SHOPIFY_ACCESS_TOKEN="shpat_xxxxxxxxxxxxxxxxxxxxx"
pnpm test files.integration.test.ts
```

**On Windows CMD:**
```cmd
set SHOPIFY_SHOP_DOMAIN=your-shop.myshopify.com
set SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxx
pnpm test files.integration.test.ts
```

### What the Test Does

1. ✅ Creates a mock Bynder client that serves the test image
2. ✅ Uploads the image to Shopify using the `uploadBynderAsset` function
3. ✅ Verifies the file was created successfully with correct file ID
4. ✅ Queries Shopify to confirm the file exists and is accessible

### Note

⚠️ **This test makes real API calls to Shopify and will create actual files in your Shopify store.** Make sure you're using a development/test store, not a production store!

### Running the Test

Set the required environment variables and run:

```bash
export SHOPIFY_SHOP_DOMAIN="your-shop.myshopify.com"
export SHOPIFY_ACCESS_TOKEN="your-access-token"
pnpm test files.integration.test.ts
```

Or on Windows PowerShell:
```powershell
$env:SHOPIFY_SHOP_DOMAIN="your-shop.myshopify.com"
$env:SHOPIFY_ACCESS_TOKEN="your-access-token"
pnpm test files.integration.test.ts
```

### What the Test Does

1. Creates a mock Bynder client that serves the test image
2. Uploads the image to Shopify using the `uploadBynderAsset` function
3. Verifies the file was created successfully
4. Queries Shopify to confirm the file exists

### Note

This test makes real API calls to Shopify and will create actual files in your Shopify store. Make sure you're using a development/test store.

