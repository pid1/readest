import { type Locator, type Page } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * The KOReader Sync integration form
 * (Settings -> Integrations -> KOReader), i.e. `KOSyncForm`.
 *
 * The form has two faces: the connect form before an account is configured,
 * and the preferences list after. `connect()` crosses from one to the other.
 */
export class KOSyncSettingsPage extends BasePage {
  readonly serverUrlInput: Locator;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly connectButton: Locator;
  readonly strategySelect: Locator;
  readonly enabledToggle: Locator;
  readonly sendMetadataToggle: Locator;
  readonly matchIdentifiersToggle: Locator;

  constructor(page: Page) {
    super(page);
    this.serverUrlInput = page.locator('input[placeholder="https://koreader.sync.server"]');
    this.usernameInput = page.locator('input[placeholder="Your Username"]');
    this.passwordInput = page.locator('input[placeholder="Your Password"]');
    this.connectButton = page.getByRole('button', {
      name: 'Connect',
      exact: true,
    });
    this.strategySelect = page.locator('select[aria-label="Sync Strategy"]');
    this.enabledToggle = this.toggleRow('Sync Server Connected');
    this.sendMetadataToggle = this.toggleRow('Send Document Metadata');
    this.matchIdentifiersToggle = this.toggleRow('Match Other Copies');
  }

  /** The checkbox of the settings row carrying `label`. */
  private toggleRow(label: string): Locator {
    return this.page.locator('label', { hasText: label }).locator('input[type="checkbox"]');
  }

  /** Library -> Settings -> Integrations -> KOReader. */
  async goto(): Promise<void> {
    await this.page.goto('/library');
    await this.page.locator('[aria-label="Your Library"]').waitFor({ state: 'visible' });
    await this.page.locator('button[aria-label="Settings Menu"]').click();
    await this.page.getByText('Settings', { exact: true }).click();
    await this.page.locator('[data-tab="Integrations"]').click();
    await this.page.getByText('KOReader', { exact: true }).first().click();
    await this.page.getByText('KOReader Sync', { exact: true }).first().waitFor();
  }

  /** Close the settings dialog. */
  async close(): Promise<void> {
    await this.page.keyboard.press('Escape');
  }

  async connect(serverUrl: string, username: string, password: string): Promise<void> {
    await this.serverUrlInput.fill(serverUrl);
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.connectButton.click();
    // The form swaps to the preferences list once the credentials are saved.
    await this.strategySelect.waitFor({ state: 'visible' });
  }

  async setStrategy(strategy: 'prompt' | 'silent' | 'send' | 'receive'): Promise<void> {
    await this.strategySelect.selectOption(strategy);
  }

  async setMatchIdentifiers(on: boolean): Promise<void> {
    if ((await this.matchIdentifiersToggle.isChecked()) === on) return;
    await this.matchIdentifiersToggle.click();
  }
}
