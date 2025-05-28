# DMQ API Reference

## /unstable/v2

*The following API reference is subject to change without notice.*

- `date`
    + The date of citation. In RFC-3339 format.
	  Only date is used, time is ignored.
	  Watch out for time zones, as it can shift by 1 day.
	  If you send `2025-05-27T23:00-01:00`, the API ignores time zone and will use *2025-05-27* instead of intended *2025-05-28*
	  To avoid it use UTC, with `Z` at the end of timestamp.
    + Example: `2025-05-28T00:00:00.000Z`
- `text`
	+ the citation text itself.
- `sourceDriveFolderId`
	+ ID of root Google Drive Folder containing folders of images. The example of expeted structure is 
	```
	|_ Photo Archives
	|_ SQ Photos 2025
	   |_ 01 Jan 2025
	   |  |_ Jan-1-20200705_KSW_1277-e.jpg
	   |  |_ Jan-2-20171206_SLH_0089-Enhanced-NR-e.jpg
	   |_ 02 Feb 2025
	   |_ 03 Mar 2025
	   |_ 04 Apr 2025
	```
	+ First encountered folder must contain current year e.g. *"whatever 2025 whatever"*
	+ inside this folder there are expected folders for each month. They must start with number and be separated by space. The number determines a month, rest of the folder name is ignored. First month (January) is 1, not 0.
	+ Example: 1RSOpu3XrQfJ4NYLsAjR8bAmGVAT_F_eR
	+ You can get it from URL, its the random text at the end -> https://drive.google.com/drive/folders/1RSOpu3XrQfJ4NYLsAjR8bAmGVAT_F_e
- `sourceDriveId`
	+ ID of Google drive where you get the `sourceDriveFolderId`. To get this, you navigate from the SG Images folder to the most top parent folder / root folder. https://drive.google.com/drive/folders/0AHp6cHlMm1PXUk9PVA The part at the end is the drive ID. Drive IDs are usually 19 characters long and can include special characters. It is shorter than ID of regular folder.
	+ Example: 0AHp6cHlMm1PXUk9PVA
- `destDriveFolderId`
	+ ID of Google drive folder where the system will upload created images.
	+ Example: 1t2JH0vmVPGcWk-sA2UCCeW-Uj5hhEZCY

## /unstable/v1

obsolete; undocumented
