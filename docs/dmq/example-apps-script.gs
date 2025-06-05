// **WARNING! The unstable APIs will be removed in future. If you experience a failure please check this page if the api was removed!**
// Future (stable) APIs will contain a speacial header to notify you in case of breaking changes.

const APIKEY = "redacted"; // API key. This key is uniqe for your team and has its usage restrictions. DO NOT SHARE THIS WITH ANYONE!
const API_URL = "api.isha-automations.fidifis.com"; // URL of API to call
const API_PATH = "/unstable/v2/dmq/make"; // Unstable path will be deprecated soon. When it happens, call fails. Check documentation for newest path.

const DATE_COLUMN = 1; // Column containg date of DMQ
const DMQ_TRASNS_COLUMN = 3; // Column containg text translation
const ASSIGNEE_COLUMN = 4; // Column containg assignee name

// Read documentation on how to get this IDs: https://github.com/Fidifis/isha-automations/blob/main/docs/README.md
const DESTINATION_FOLDER_ID = "1dKD9qRO6T8-SfSy13uJmdORl63jNkjbl"; // Folder ID where the result images are uploaded
const IMAGES_FOLDER_ID = "1RSOpu3XrQfJ4NYLsAjR8bAmGVAT_F_eR"; // Folder ID of images
const IMAGES_DRIVE_ID = "0AHp6cHlMm1PXUk9PVA"; // Drive ID of images folder


function makeDmq() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet(); // Get current sheet
  const activeCell = cellA1ToIndex(sheet.getActiveCell().getA1Notation(), 1); // Get active cell

  const translated = sheet.getRange(activeCell.row, DMQ_TRASNS_COLUMN).getValue(); // Get translated text

  const date = sheet.getRange(activeCell.row, DATE_COLUMN).getValue(); // Get date
  const stdDate = Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss'Z'"); // Convert to standard RFC-3339 / ISO-8601 date format

  // Object with the request payload
  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": APIKEY,
    },
    payload: JSON.stringify({ // Notice, the payload is JSON stringified object
      // Here define the request parameters
      // Descriptions in docs on GitHub https://github.com/Fidifis/isha-automations/blob/main/docs/dmq/api.md
      "date": stdDate,
      "text": translated,
      "sourceDriveId": IMAGES_DRIVE_ID, // TODO: Make this optional
      "sourceDriveFolderId": IMAGES_FOLDER_ID, // TODO: Make this optional
      "destDriveFolderId": DESTINATION_FOLDER_ID,
    }),
    muteHttpExceptions: true // Idk if needed
  };

  const response = UrlFetchApp.fetch(`https://${API_URL}${API_PATH}`, options); // Calls the API
  const status = response.getResponseCode();

  // If not success, throw error
  if (status !== 200) {
    throw Error("Got response status code " + status)
  }

  // Show alert on deprecated API calls
  deprecationAlert(response);

  // Mark as done
  markEditDone(activeCell.row, sheet);
}

/**
 * Check if API returned deprecation flag. If true, you should migrate to new API, as the old one will eventually shut down.
 * @param {UrlFetchApp.HTTPResponse} response The response from UrlFetchApp
 */
function deprecationAlert(response) {
  const headers = response.getHeaders();
  const deprecationMessage = headers['x-deprecated-version'];

  if (deprecationMessage !== undefined) {
    SpreadsheetApp.getUi().alert("The API calls you are currently using are deprecated! Please migrate to new version. Deprecation message: " + deprecationMessage);
  }
}

/**
 * On successful run, put 'DMQ Maker' as assignee and mark done
 */
function markEditDone(row, sheet) {
  sheet.getRange(row, ASSIGNEE_COLUMN).setValue("DMQ Maker");
  sheet.getRange(row, ASSIGNEE_COLUMN + 1).setValue(true);
}
