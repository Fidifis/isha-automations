# Daily Mystic Quotes

This service takes a text and an image link (from Google Drive), combines them to create a styled "Daily Mystic Quote" image, and delivers the result back to Google Drive. It ensures a unified look, with fully automated processing.

# API Reference

read at [api.md](./api.md)

# Example

Example to invoke with JavaScript:

```js
const isoDate = Utilities.formatDate(requestedDate(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");

const options = {
  method: "post",
  contentType: "application/json",
  headers: {
    "x-auth-id": KEYID,
    "x-auth-key": APIKEY,
  },
  payload: JSON.stringify({
    "date": isoDate,
    "text": loadTheCitation(isoDate),
    "sourceDriveId": "0AHp6cHlMm1PXUk9PVA",
    "destDriveFolderId": "1t2JH0vmVPGcWk-sA2UCCeW-Uj5hhEZCY",
    "sourceDriveFolderId": "1RSOpu3XrQfJ4NYLsAjR8bAmGVAT_F_eR"
  }),
  muteHttpExceptions: true
};

const response = UrlFetchApp.fetch(API_URL, options);
```
