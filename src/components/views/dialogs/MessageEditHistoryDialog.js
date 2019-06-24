/*
Copyright 2019 The Matrix.org Foundation C.I.C.

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
import PropTypes from 'prop-types';
import MatrixClientPeg from "../../../MatrixClientPeg";
import { _t } from '../../../languageHandler';
import sdk from "../../../index";
import {wantsDateSeparator} from '../../../DateUtils';
import SettingsStore from '../../../settings/SettingsStore';

export default class MessageEditHistoryDialog extends React.Component {
    static propTypes = {
        mxEvent: PropTypes.object.isRequired,
    };

    componentWillMount() {
        this.setState({
            edits: [this.props.mxEvent],
            isLoading: true,
            isTwelveHour: SettingsStore.getValue("showTwelveHourTimestamps"),
        });
    }

    async componentDidMount() {
        const roomId = this.props.mxEvent.getRoomId();
        const eventId = this.props.mxEvent.getId();
        let edits = await MatrixClientPeg.get().
            relations(roomId, eventId, "m.replace", "m.room.message");
        edits = edits.slice().reverse();
        edits.unshift(this.props.mxEvent);
        this.setState({edits, isLoading: false});
    }

    _renderEdits() {
        const EditHistoryMessage = sdk.getComponent('elements.EditHistoryMessage');
        const DateSeparator = sdk.getComponent('messages.DateSeparator');
        const nodes = [];
        let lastEvent;
        this.state.edits.forEach(e => {
            if (!lastEvent || wantsDateSeparator(lastEvent.getDate(), e.getDate())) {
                nodes.push(<li key={e.getTs() + "~"}><DateSeparator ts={e.getTs()} /></li>);
            }
            nodes.push(<EditHistoryMessage key={e.getId()} mxEvent={e} isTwelveHour={this.state.isTwelveHour} />);
            lastEvent = e;
        });
        return nodes;
    }

    render() {
        const BaseDialog = sdk.getComponent('views.dialogs.BaseDialog');
        let spinner;
        const edits = this._renderEdits();
        if (this.state.isLoading) {
            const Spinner = sdk.getComponent("elements.Spinner");
            spinner = <Spinner />;
        }
        return (
            <BaseDialog className='mx_MessageEditHistoryDialog' hasCancel={true}
                        onFinished={this.props.onFinished} title={_t("Message edits")}>
                <ul>{edits}</ul>
                {spinner}
            </BaseDialog>
        );
    }
}
