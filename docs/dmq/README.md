# Daily Mystic Quotes

This service takes a text and an image link (from Google Drive), combines them to create a styled "Daily Mystic Quote" image, and delivers the result back to Google Drive. It ensures a unified look, with fully automated processing.

The system currently works **asynchronously**.
This means the request will result with success (http 200), but the process itself is still running in background and can fail.
If you cannot find result image, this is very likely an error in the proccess. Please contact administrators of this project for further investigation. Or create an issue.
Currently there is no api call to check for state of the task. *( We just hope it won't break :) )*

# API Reference

read at [api.md](./api.md)

**WARNING! The unstable APIs will be removed in future. If you experience a failure please check this page if the api was removed!**
And check an [example](./example-apps-script.gs) how to use it.
Future (stable) APIs will contain a speacial header to notify you in case of breaking changes.

# Example

Example of code in Google sheets Apps script [example-apps-script.gs](./example-apps-script.gs)
