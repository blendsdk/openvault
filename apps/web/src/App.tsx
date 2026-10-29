import { DescriptionList, DescriptionListItem } from "@blendsdk/fluentui-react-components";
import { Button, Card, FluentProvider, Text, webLightTheme } from "@fluentui/react-components";
import { GlobalLoaderProvider } from "blendsdk/react";

/**
 * Minimal shell used to prove the React 19, Fluent UI v9, and BlendSDK integration.
 * The real project and secret screens are added in the UI phase.
 */
export function App() {
  return (
    <FluentProvider theme={webLightTheme}>
      <GlobalLoaderProvider>
        <main className="shell">
          <Card className="hero">
            <Text weight="semibold" style={{ fontSize: 30 }}>
              OpenVault
            </Text>
            <Text>
              Self-hosted secrets and certificates for Docker Compose projects, built on BlendSDK
              v5.
            </Text>
            <DescriptionList layout="columns">
              <DescriptionListItem label="Status">Scaffold</DescriptionListItem>
              <DescriptionListItem label="API">/v1/ready</DescriptionListItem>
              <DescriptionListItem label="Docs">GitHub Pages</DescriptionListItem>
            </DescriptionList>
            <Button
              appearance="primary"
              onClick={() => {
                window.location.assign("/v1/ready");
              }}
            >
              Check API
            </Button>
          </Card>
        </main>
      </GlobalLoaderProvider>
    </FluentProvider>
  );
}
