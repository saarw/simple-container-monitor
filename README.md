# Docker Container Monitor with Notion Page Integration

This single-file TypeScript application monitors Docker containers and logs their CPU and memory usage every minute to a Notion Page so you can view them in the Notion mobile app.

## Setup
Create a Notion integration:
- Go to https://www.notion.so/my-integrations
- Click "New integration"
- Name your integration (e.g., "Container Monitor")
- Select the workspace where you want to use the integration
- Set the capabilities needed (Read content, Update content, Insert content)
- Click "Submit" to create the integration
- Copy the "Internal Integration Token" - this is your NOTION_TOKEN

Create an empty Notion page that will be overwritten with stats and associate it with your integration:
- Click "..." in the top right of the page
- Go to the Connections submenu and select your integration
- Copy the page ID from the URL (the part after the workspace name and before the question mark)
   Example: https://www.notion.so/workspace/83c75a51b3b8476b97c0a5141f72b9e9
   The ID is: 83c75a51b3b8476b97c0a5141f72b9e9

You can deploy the monitor to a container in your Docker instance by cloning/downloading the SimpleContainerMonitor.ts file and running the following Docker command.
```
docker run -d --name container-monitor \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /absolute_path/to/SimpleContainerMonitor.ts:/app/SimpleContainerMonitor.ts \
  -e NOTION_TOKEN=secret_abcdefghijklmnopqrstuvwxyz1234567890 \
  -e NOTION_PAGE_ID=page_id \
  -w /app \
  node:lts \
  npx tsx SimpleContainerMonitor.ts
```


### Environment Variables

- `NOTION_TOKEN` (required): The integration token from step 1
- `NOTION_PAGE_ID` (required): ID of an existing page to update


## Prerequisites

- Node.js 18 or higher
- Access to Docker daemon through `/var/run/docker.sock`
- Notion account

# simple-container-monitor

Docker container monitoring with Notion page integration.

## Installation

```sh
npm install simple-container-monitor
```

## Usage

// ... Add usage instructions here ...

## Publishing

To publish this module to npm:

1. Update the `author`, `repository`, and other fields in `package.json` as needed.
2. Run the following commands:

```sh
npm run build
npm publish
```

## License

This project is licensed under the [MIT License](./LICENSE).