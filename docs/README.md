# Documentation

## Services

- [Daily Mystic Quotes (DMQ)](./dmq/README.md)
- [Video Render](./video-render/README.md)

## Google integration

As Isha uses Google Drive as a content storage, most of (or rather all) services needs access to your Google Drive.

**To allow the systems to access your Google Services (like Drive) please give permissions to this account (email is below).** Do it like for any other team member and it should work fine.

Google Cloud Platform service account is used for accessing google. Under GCP project: "isha-automations-231309".

It has a federated trust policy, between the GCP project and production AWS account. No secrets.

The GCP service account:

- **email: awscloud@isha-automations-231309.iam.gserviceaccount.com**
- name: AWS
- id: 112086028889105414929

### Google folder IDs

To find a Google folder ID, open the folder in your web browser. Look at the URL—it will look something like this:
`https://drive.google.com/drive/folders/1RSOpu3XrQfJ4NYLsAjR8bAmGVAT_F_e`

The folder ID is the long string of letters, numbers, dashes, or underscores at the end of the URL.
In this example, the folder ID is:
`1RSOpu3XrQfJ4NYLsAjR8bAmGVAT_F_e`

### Google Drive ID

A Drive ID refers to the unique identifier of a Shared Drive - a type of Google Drive managed by an organization (Isha).

To find the Drive ID:

- Open a folder that is part of a Shared Drive.
- Navigate up through the folder structure until you reach the root (top-level) of the Shared Drive.
- At the top, you’ll see the name of the Shared Drive - this indicates you're in the right place.
- Copy the random string at the end of the URL. This is the Drive ID.

Shared Drive IDs are typically shorter than regular folder IDs, usually around 19 characters.

## API Authorization

To be able to make any API call you need to auth.
Each team gets an ID and Key.
To use API provide this values in headers of each request.

```json
{
  "headers": {
    "x-api-key": "abcd123"
  }
}
```

Currently we use HTTP API gateway with custom authorizer. For future we plan using a REST api with Api keys and Usage plans. **So the API key may change in future!** There shouldn't be any other change for api consumers.

### The source

The API keys are stored inside AWS Systems Manager Parameter Store.
The Authorizer Lambda has a base path to recursively search for keys.
Currently this is set to `/isha/auth/{env}`
Then follows a key name - composed of department and sub-entity (country code, in case of Global Reach) 
`/isha/auth/live/GR/cz`

## Fonts

This table tracks what fonts are used for what purpose

| Font              | S3 Key                | Purpose      |
| ----------------- | --------------------- | ------------ |
| Open Sans (bold)  | open_sans_bold.ttf    | Video render |
| Merriweather Sans | merriweather_sans.ttf | DMQ fallback |
