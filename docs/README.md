# Documentation

## API Authorization

To be able to make any API call you need to auth.
Each team gets an ID and Key.
To use API provide this values in headers of each request.

```json
{
  "headers": {
    "x-auth-id": "/department/team",
    "x-auth-key": "abcd123"
  }
}
```

## Services

- [Daily Mystic Quotes (DMQ)](./dmq/README.md)
