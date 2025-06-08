# Video Render

This service is capable of rendering a short videos with subtitles burned in. As an input you specify folder with stems, folder with translated text in SRT format. Video is rendered by selecting a video file from stems, combining all audio files and burning  subtitles. Resulting video is saved to specified Google Drive folder.

## SRT extraction

Only option for SRT is to extract them from a Google Document. The system expects a Google folder ID which contains a Google Document (not `.docx`), prefixed with `SUB_` . This file must contain valid SRT formated subtitles. It can be writen in a table.

It is required to have a special mark at the start `{{translation_start}}` and `{{translation_end}}` at the end. By this marks helps the system to find the correct text in a more complex document structure.

During processing the srt is reformatted, to comply with srt formating. This means, all unnecessary new lines and white spaces are removed.

## How content is selected

On the request you must provide a Google drive folder which contains a Stems folder. Directly specifing the stems folder is not supported.

The required folder usually contains a `REF_abc.mp4` video and a folder `Stems` or a folder link `OCD-1234-abc`. The process fails if the folder is not found or they are empty.

From the found stems folder all audio files are used. (in the code there is a list of extensions which are accepted as audio).

Only one video file is picked. In case of multiple videos, an algorithm is used to select a video with high probability of being plain (without texts, subtitles, ...) For this each video file is given a score based on file extension, number of word "copy" in the name and with highest priority if it does contain "All video". It is case insensitive and ignores spaces. There is still posibility to get an equal score on multiple files. When this happens a random video is picked.

## Result Status Delivery

To signalize completion or error, api call can (must) have delivery options. It will put a status message to your spreadsheet. The options are saying what type of delivery to use (deliver to google spreadsheet), id of this spreadheed, list, coordinates of a cell and content to put into it. To calrify it is something like "To spreadheet xyz, on list named Videos, put to cell H6, text Done".

For error delivery there are error delivery options. They have same structure as the regular ones. This error deilvery can replace a placeholder in text `$errmsg` with an actual error message.

# API Reference

read at [api.md](./api.md)

**WARNING! The unstable APIs will be removed in future. If you experience a failure please check this page if the api was removed!**
