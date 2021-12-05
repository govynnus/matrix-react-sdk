/*
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>
Copyright 2015, 2016, 2017, 2018, 2019, 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React from 'react';
import { MatrixClient } from 'matrix-js-sdk/src/client';
import { AuthType } from "matrix-js-sdk/src/interactive-auth";

import * as Email from '../../../email';
import { looksValid as phoneNumberLooksValid } from '../../../phonenumber';
import Modal from '../../../Modal';
import { _t, _td } from '../../../languageHandler';
import SdkConfig from '../../../SdkConfig';
import { SAFE_LOCALPART_REGEX, REGISTRATION_TOKEN_REGEX } from '../../../Registration';
import withValidation, { IValidationResult } from '../elements/Validation';
import { ValidatedServerConfig } from "../../../utils/AutoDiscoveryUtils";
import EmailField from "./EmailField";
import PassphraseField from "./PassphraseField";
import CountlyAnalytics from "../../../CountlyAnalytics";
import Field from '../elements/Field';
import RegistrationEmailPromptDialog from '../dialogs/RegistrationEmailPromptDialog';
import { replaceableComponent } from "../../../utils/replaceableComponent";
import CountryDropdown from "./CountryDropdown";

import { logger } from "matrix-js-sdk/src/logger";
import PassphraseConfirmField from "./PassphraseConfirmField";

enum RegistrationField {
    Email = "field_email",
    PhoneNumber = "field_phone_number",
    Username = "field_username",
    Password = "field_password",
    PasswordConfirm = "field_password_confirm",
    RegistrationToken = "field_registration_token",
}

export const PASSWORD_MIN_SCORE = 3; // safely unguessable: moderate protection from offline slow-hash scenario.

interface IProps {
    // Values pre-filled in the input boxes when the component loads
    defaultEmail?: string;
    defaultPhoneCountry?: string;
    defaultPhoneNumber?: string;
    defaultUsername?: string;
    defaultPassword?: string;
    defaultRegistrationToken?: string;
    flows: {
        stages: string[];
    }[];
    serverConfig: ValidatedServerConfig;
    canSubmit?: boolean;
    matrixClient: MatrixClient;

    onRegisterClick(params: {
        username: string;
        password: string;
        email?: string;
        phoneCountry?: string;
        phoneNumber?: string;
        registrationToken?: string;
    }): Promise<void>;
    onEditServerDetailsClick?(): void;
}

interface IState {
    // Field error codes by field ID
    fieldValid: Partial<Record<RegistrationField, boolean>>;
    // The ISO2 country code selected in the phone number entry
    phoneCountry: string;
    username: string;
    email: string;
    phoneNumber: string;
    password: string;
    passwordConfirm: string;
    passwordComplexity?: number;
    registrationToken: string;
}

/*
 * A pure UI component which displays a registration form.
 */
@replaceableComponent("views.auth.RegistrationForm")
export default class RegistrationForm extends React.PureComponent<IProps, IState> {
    static defaultProps = {
        onValidationChange: logger.error,
        canSubmit: true,
    };

    constructor(props) {
        super(props);

        this.state = {
            fieldValid: {},
            phoneCountry: this.props.defaultPhoneCountry,
            username: this.props.defaultUsername || "",
            email: this.props.defaultEmail || "",
            phoneNumber: this.props.defaultPhoneNumber || "",
            password: this.props.defaultPassword || "",
            passwordConfirm: this.props.defaultPassword || "",
            passwordComplexity: null,
            registrationToken: this.props.defaultRegistrationToken || "",
        };

        CountlyAnalytics.instance.track("onboarding_registration_begin");
    }

    private onSubmit = async ev => {
        ev.preventDefault();
        ev.persist();

        if (!this.props.canSubmit) return;

        const allFieldsValid = await this.verifyFieldsBeforeSubmit();
        if (!allFieldsValid) {
            CountlyAnalytics.instance.track("onboarding_registration_submit_failed");
            return;
        }

        if (this.state.email === '') {
            if (this.showEmail()) {
                CountlyAnalytics.instance.track("onboarding_registration_submit_warn");
                Modal.createTrackedDialog("Email prompt dialog", '', RegistrationEmailPromptDialog, {
                    onFinished: async (confirmed: boolean, email?: string) => {
                        if (confirmed) {
                            this.setState({
                                email,
                            }, () => {
                                this.doSubmit(ev);
                            });
                        }
                    },
                });
            } else {
                // user can't set an e-mail so don't prompt them to
                this.doSubmit(ev);
                return;
            }
        } else {
            this.doSubmit(ev);
        }
    };

    private doSubmit(ev) {
        const email = this.state.email.trim();

        CountlyAnalytics.instance.track("onboarding_registration_submit_ok", {
            email: !!email,
        });

        const promise = this.props.onRegisterClick({
            username: this.state.username.trim(),
            password: this.state.password.trim(),
            email: email,
            phoneCountry: this.state.phoneCountry,
            phoneNumber: this.state.phoneNumber,
            registrationToken: this.state.registrationToken,
        });

        if (promise) {
            ev.target.disabled = true;
            promise.finally(function() {
                ev.target.disabled = false;
            });
        }
    }

    private async verifyFieldsBeforeSubmit() {
        // Blur the active element if any, so we first run its blur validation,
        // which is less strict than the pass we're about to do below for all fields.
        const activeElement = document.activeElement as HTMLElement;
        if (activeElement) {
            activeElement.blur();
        }

        const fieldIDsInDisplayOrder = [
            RegistrationField.Username,
            RegistrationField.Password,
            RegistrationField.PasswordConfirm,
            RegistrationField.RegistrationToken,
            RegistrationField.Email,
            RegistrationField.PhoneNumber,
        ];

        // Run all fields with stricter validation that no longer allows empty
        // values for required fields.
        for (const fieldID of fieldIDsInDisplayOrder) {
            const field = this[fieldID];
            if (!field) {
                continue;
            }
            // We must wait for these validations to finish before queueing
            // up the setState below so our setState goes in the queue after
            // all the setStates from these validate calls (that's how we
            // know they've finished).
            await field.validate({ allowEmpty: false });
        }

        // Validation and state updates are async, so we need to wait for them to complete
        // first. Queue a `setState` callback and wait for it to resolve.
        await new Promise<void>(resolve => this.setState({}, resolve));

        if (this.allFieldsValid()) {
            return true;
        }

        const invalidField = this.findFirstInvalidField(fieldIDsInDisplayOrder);

        if (!invalidField) {
            return true;
        }

        // Focus the first invalid field and show feedback in the stricter mode
        // that no longer allows empty values for required fields.
        invalidField.focus();
        invalidField.validate({ allowEmpty: false, focused: true });
        return false;
    }

    /**
     * @returns {boolean} true if all fields were valid last time they were validated.
     */
    private allFieldsValid() {
        const keys = Object.keys(this.state.fieldValid);
        for (let i = 0; i < keys.length; ++i) {
            if (!this.state.fieldValid[keys[i]]) {
                return false;
            }
        }
        return true;
    }

    private findFirstInvalidField(fieldIDs: RegistrationField[]) {
        for (const fieldID of fieldIDs) {
            if (!this.state.fieldValid[fieldID] && this[fieldID]) {
                return this[fieldID];
            }
        }
        return null;
    }

    private markFieldValid(fieldID: RegistrationField, valid: boolean) {
        const { fieldValid } = this.state;
        fieldValid[fieldID] = valid;
        this.setState({
            fieldValid,
        });
    }

    private onEmailChange = ev => {
        this.setState({
            email: ev.target.value,
        });
    };

    private onEmailValidate = (result: IValidationResult) => {
        this.markFieldValid(RegistrationField.Email, result.valid);
    };

    private validateEmailRules = withValidation({
        description: () => _t("Use an email address to recover your account"),
        hideDescriptionIfValid: true,
        rules: [
            {
                key: "required",
                test(this: RegistrationForm, { value, allowEmpty }) {
                    return allowEmpty || !this.authStepIsRequired('m.login.email.identity') || !!value;
                },
                invalid: () => _t("Enter email address (required on this homeserver)"),
            },
            {
                key: "email",
                test: ({ value }) => !value || Email.looksValid(value),
                invalid: () => _t("Doesn't look like a valid email address"),
            },
        ],
    });

    private onPasswordChange = ev => {
        this.setState({
            password: ev.target.value,
        });
    };

    private onPasswordValidate = result => {
        this.markFieldValid(RegistrationField.Password, result.valid);
    };

    private onPasswordConfirmChange = ev => {
        this.setState({
            passwordConfirm: ev.target.value,
        });
    };

    private onPasswordConfirmValidate = (result: IValidationResult) => {
        this.markFieldValid(RegistrationField.PasswordConfirm, result.valid);
    };

    private onPhoneCountryChange = newVal => {
        this.setState({
            phoneCountry: newVal.iso2,
        });
    };

    private onPhoneNumberChange = ev => {
        this.setState({
            phoneNumber: ev.target.value,
        });
    };

    private onPhoneNumberValidate = async fieldState => {
        const result = await this.validatePhoneNumberRules(fieldState);
        this.markFieldValid(RegistrationField.PhoneNumber, result.valid);
        return result;
    };

    private validatePhoneNumberRules = withValidation({
        description: () => _t("Other users can invite you to rooms using your contact details"),
        hideDescriptionIfValid: true,
        rules: [
            {
                key: "required",
                test(this: RegistrationForm, { value, allowEmpty }) {
                    return allowEmpty || !this.authStepIsRequired('m.login.msisdn') || !!value;
                },
                invalid: () => _t("Enter phone number (required on this homeserver)"),
            },
            {
                key: "email",
                test: ({ value }) => !value || phoneNumberLooksValid(value),
                invalid: () => _t("That phone number doesn't look quite right, please check and try again"),
            },
        ],
    });

    private onUsernameChange = ev => {
        this.setState({
            username: ev.target.value,
        });
    };

    private onUsernameValidate = async fieldState => {
        const result = await this.validateUsernameRules(fieldState);
        this.markFieldValid(RegistrationField.Username, result.valid);
        return result;
    };

    private validateUsernameRules = withValidation({
        description: (_, results) => {
            // omit the description if the only failing result is the `available` one as it makes no sense for it.
            if (results.every(({ key, valid }) => key === "available" || valid)) return;
            return _t("Use lowercase letters, numbers, dashes and underscores only");
        },
        hideDescriptionIfValid: true,
        rules: [
            {
                key: "required",
                test: ({ value, allowEmpty }) => allowEmpty || !!value,
                invalid: () => _t("Enter username"),
            },
            {
                key: "safeLocalpart",
                test: ({ value }) => !value || SAFE_LOCALPART_REGEX.test(value),
                invalid: () => _t("Some characters not allowed"),
            },
            {
                key: "available",
                final: true,
                test: async ({ value }) => {
                    if (!value) {
                        return true;
                    }

                    try {
                        await this.props.matrixClient.isUsernameAvailable(value);
                        return true;
                    } catch (err) {
                        return false;
                    }
                },
                invalid: () => _t("Someone already has that username. Try another or if it is you, sign in below."),
            },
        ],
    });

    private onRegistrationTokenChange = ev => {
        this.setState({
            registrationToken: ev.target.value,
        });
    };

    private onRegistrationTokenValidate = async fieldState => {
        const result = await this.validateRegistrationTokenRules(fieldState);
        this.markFieldValid(RegistrationField.RegistrationToken, result.valid);
        return result;
    };

    private validateRegistrationTokenRules = withValidation({
        description: () => _t("Use a registration token to authenticate your registration"),
        hideDescriptionIfValid: true,
        rules: [
            {
                key: "length",
                test: ({ value }) => value.length <= 64,
                invalid: () => _t("Registration token is more than 64 characters long"),
            },
            {
                key: "permittedCharacters",
                test: ({ value }) => !value || REGISTRATION_TOKEN_REGEX.test(value),
                invalid: () => _t("Registration token contains unpermitted characters."),
            },
        ],
    });

    /**
     * A step is required if all flows include that step.
     *
     * @param {string} step A stage name to check
     * @returns {boolean} Whether it is required
     */
    private authStepIsRequired(step: string) {
        return this.props.flows.every((flow) => {
            return flow.stages.includes(step);
        });
    }

    /**
     * A step is used if any flows include that step.
     *
     * @param {string} step A stage name to check
     * @returns {boolean} Whether it is used
     */
    private authStepIsUsed(step: string) {
        return this.props.flows.some((flow) => {
            return flow.stages.includes(step);
        });
    }

    private showEmail() {
        if (!this.authStepIsUsed('m.login.email.identity')) {
            return false;
        }
        return true;
    }

    private showPhoneNumber() {
        const threePidLogin = !SdkConfig.get().disable_3pid_login;
        if (!threePidLogin || !this.authStepIsUsed('m.login.msisdn')) {
            return false;
        }
        return true;
    }

    private showRegistrationToken() {
        if (!this.authStepIsUsed(AuthType.RegistrationToken)) {
            return false;
        }
        return true;
    }

    private renderEmail() {
        if (!this.showEmail()) {
            return null;
        }
        const emailLabel = this.authStepIsRequired('m.login.email.identity') ?
            _td("Email") :
            _td("Email (optional)");
        return <EmailField
            fieldRef={field => this[RegistrationField.Email] = field}
            label={emailLabel}
            value={this.state.email}
            validationRules={this.validateEmailRules.bind(this)}
            onChange={this.onEmailChange}
            onValidate={this.onEmailValidate}
            onFocus={() => CountlyAnalytics.instance.track("onboarding_registration_email_focus")}
            onBlur={() => CountlyAnalytics.instance.track("onboarding_registration_email_blur")}
        />;
    }

    private renderPassword() {
        return <PassphraseField
            id="mx_RegistrationForm_password"
            fieldRef={field => this[RegistrationField.Password] = field}
            minScore={PASSWORD_MIN_SCORE}
            value={this.state.password}
            onChange={this.onPasswordChange}
            onValidate={this.onPasswordValidate}
            onFocus={() => CountlyAnalytics.instance.track("onboarding_registration_password_focus")}
            onBlur={() => CountlyAnalytics.instance.track("onboarding_registration_password_blur")}
        />;
    }

    renderPasswordConfirm() {
        return <PassphraseConfirmField
            id="mx_RegistrationForm_passwordConfirm"
            fieldRef={field => this[RegistrationField.PasswordConfirm] = field}
            autoComplete="new-password"
            value={this.state.passwordConfirm}
            password={this.state.password}
            onChange={this.onPasswordConfirmChange}
            onValidate={this.onPasswordConfirmValidate}
            onFocus={() => CountlyAnalytics.instance.track("onboarding_registration_passwordConfirm_focus")}
            onBlur={() => CountlyAnalytics.instance.track("onboarding_registration_passwordConfirm_blur")}
        />;
    }

    renderPhoneNumber() {
        if (!this.showPhoneNumber()) {
            return null;
        }
        const phoneLabel = this.authStepIsRequired('m.login.msisdn') ?
            _t("Phone") :
            _t("Phone (optional)");
        const phoneCountry = <CountryDropdown
            value={this.state.phoneCountry}
            isSmall={true}
            showPrefix={true}
            onOptionChange={this.onPhoneCountryChange}
        />;
        return <Field
            ref={field => this[RegistrationField.PhoneNumber] = field}
            type="text"
            label={phoneLabel}
            value={this.state.phoneNumber}
            prefixComponent={phoneCountry}
            onChange={this.onPhoneNumberChange}
            onValidate={this.onPhoneNumberValidate}
        />;
    }

    renderUsername() {
        return <Field
            id="mx_RegistrationForm_username"
            ref={field => this[RegistrationField.Username] = field}
            type="text"
            autoFocus={true}
            label={_t("Username")}
            placeholder={_t("Username").toLocaleLowerCase()}
            value={this.state.username}
            onChange={this.onUsernameChange}
            onValidate={this.onUsernameValidate}
            onFocus={() => CountlyAnalytics.instance.track("onboarding_registration_username_focus")}
            onBlur={() => CountlyAnalytics.instance.track("onboarding_registration_username_blur")}
        />;
    }

    renderRegistrationToken() {
        if (!this.showRegistrationToken()) {
            return null;
        }
        return <Field
            id="mx_RegistrationForm_registrationToken"
            ref={field => this[RegistrationField.RegistrationToken] = field}
            type="text"
            label={_t("Registration token")}
            placeholder={_t("Registration token").toLocaleLowerCase()}
            value={this.state.registrationToken}
            onChange={this.onRegistrationTokenChange}
            onValidate={this.onRegistrationTokenValidate}
        />;
    }

    render() {
        const registerButton = (
            <input className="mx_Login_submit" type="submit" value={_t("Register")} disabled={!this.props.canSubmit} />
        );

        let emailHelperText = null;
        if (this.showEmail()) {
            if (this.showPhoneNumber()) {
                emailHelperText = <div>
                    {
                        _t("Add an email to be able to reset your password.")
                    } {
                        _t("Use email or phone to optionally be discoverable by existing contacts.")
                    }
                </div>;
            } else {
                emailHelperText = <div>
                    {
                        _t("Add an email to be able to reset your password.")
                    } {
                        _t("Use email to optionally be discoverable by existing contacts.")
                    }
                </div>;
            }
        }

        return (
            <div>
                <form onSubmit={this.onSubmit}>
                    <div className="mx_AuthBody_fieldRow">
                        { this.renderUsername() }
                    </div>
                    <div className="mx_AuthBody_fieldRow">
                        { this.renderPassword() }
                        { this.renderPasswordConfirm() }
                    </div>
                    <div className="mx_AuthBody_fieldRow">
                        { this.renderRegistrationToken() }
                    </div>
                    <div className="mx_AuthBody_fieldRow">
                        { this.renderEmail() }
                        { this.renderPhoneNumber() }
                    </div>
                    { emailHelperText }
                    { registerButton }
                </form>
            </div>
        );
    }
}
