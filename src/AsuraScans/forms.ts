import {
    ButtonRow,
    Form,
    InputRow,
    LabelRow,
    Section,
    type FormSectionElement,
    type SelectorID,
} from "@paperback/types";

const API_BASE = "https://api.asurascans.com";

class State<T> {
    private _value: T;

    get value(): T {
        return this._value;
    }

    get selector(): SelectorID<(value: T) => Promise<void>> {
        return Application.Selector(this as State<T>, "updateValue");
    }

    constructor(
        private form: Form,
        value: T,
    ) {
        this._value = value;
    }

    async updateValue(value: T): Promise<void> {
        this._value = value;
        this.form.reloadForm();
    }
}

export class AsuraSettingsForm extends Form {
    emailInput = new State(
        this,
        (Application.getState("asura_email") as string) ?? "",
    );
    passwordInput = new State(this, "");
    statusMessage = new State(this, "");

    override getSections(): FormSectionElement[] {
        const savedEmail =
            (Application.getState("asura_email") as string) ?? "";
        const hasToken = Boolean(
            Application.getSecureState("asura_access_token"),
        );
        const loginStatus = hasToken
            ? `Logged in as ${savedEmail}`
            : "Not logged in";

        return [
            Section("status", [
                LabelRow("loginStatus", {
                    title: "Account status",
                    value: loginStatus,
                }),
                ...(() =>
                    this.statusMessage.value
                        ? [
                              LabelRow("message", {
                                  title: this.statusMessage.value,
                                  value: "",
                              }),
                          ]
                        : [])(),
            ]),

            Section("credentials", [
                InputRow("email", {
                    title: "Email",
                    value: this.emailInput.value,
                    onValueChange: this.emailInput.selector,
                }),
                InputRow("password", {
                    title: "Password",
                    value: this.passwordInput.value,
                    onValueChange: this.passwordInput.selector,
                }),
                ButtonRow("loginBtn", {
                    title: hasToken ? "Re-login" : "Login",
                    onSelect: Application.Selector(
                        this as AsuraSettingsForm,
                        "login",
                    ),
                }),
                ...(() =>
                    hasToken
                        ? [
                              ButtonRow("logoutBtn", {
                                  title: "Logout",
                                  onSelect: Application.Selector(
                                      this as AsuraSettingsForm,
                                      "logout",
                                  ),
                              }),
                          ]
                        : [])(),
            ]),

            Section("info", [
                LabelRow("hint", {
                    title: "Why login?",
                    subtitle:
                        "Login with your AsuraScans account to read early access chapters immediately instead of waiting for the free release window.",
                    value: "",
                }),
            ]),
        ];
    }

    async login(): Promise<void> {
        const email = this.emailInput.value.trim();
        const password = this.passwordInput.value;

        if (!email || !password) {
            await this.statusMessage.updateValue(
                "Email and password are required.",
            );
            return;
        }

        await this.statusMessage.updateValue("Logging in…");

        try {
            const [response, data] = await Application.scheduleRequest({
                url: `${API_BASE}/api/auth/login`,
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password, remember_me: true }),
            });

            const json = JSON.parse(
                Application.arrayBufferToUTF8String(data),
            ) as Record<string, unknown>;

            if (response.status !== 200) {
                const errMsg =
                    (json["error"] as string) ?? `HTTP ${response.status}`;
                await this.statusMessage.updateValue(`Login failed: ${errMsg}`);
                return;
            }

            const token = (json["data"] as Record<string, unknown>)?.[
                "access_token"
            ] as string | undefined;

            if (!token) {
                await this.statusMessage.updateValue(
                    "Login failed: no token returned.",
                );
                return;
            }

            Application.setSecureState(token, "asura_access_token");
            Application.setState(email, "asura_email");

            this.passwordInput = new State(this, "");
            await this.statusMessage.updateValue("");
            this.reloadForm();
        } catch (e) {
            await this.statusMessage.updateValue(`Login error: ${String(e)}`);
        }
    }

    async logout(): Promise<void> {
        Application.setSecureState(null, "asura_access_token");
        Application.setState("", "asura_email");
        await this.statusMessage.updateValue("");
        this.reloadForm();
    }
}
