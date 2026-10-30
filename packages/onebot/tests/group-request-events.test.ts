import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type { GroupInvite, GroupJoin } from '@snowluma/proto-defs/notify';
import type { OidbBase, OidbSvcTrpcTcp0x10C0Response } from '@snowluma/proto-defs/oidb';
import { protobuf_encode } from '@snowluma/proton';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { MSG_PUSH_CMD } from '@snowluma/protocol/msg-push';
import type { GroupInviteEvent } from '@snowluma/protocol/events';
import type { GroupRequestInfo } from '@snowluma/protocol/qq-info';
import { convertEvent } from '../src/event-converter';
import { getGroupSystemMessages } from '../src/modules/contact-actions';
import { handleGroupAddRequest } from '../src/modules/request-actions';
import { Bridge } from '@snowluma/core/bridge';

const bridges: Bridge[] = [];

afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()));
    vi.useRealTimers();
});

function setup() {
    const bridge = new Bridge(IdentityService.memory('10001'));
    bridges.push(bridge);
    const received: GroupInviteEvent[] = [];
    bridge.events.on('group_invite', (event) => {
        received.push(event);
    });
    const fetchRequests = vi.spyOn(bridge.apis.contacts, 'fetchGroupRequestsByUid');
    const fetchNumericRequests = vi.spyOn(bridge.apis.contacts, 'fetchGroupRequests');
    return { bridge, received, fetchRequests, fetchNumericRequests };
}

function packet(message: PushMsg['message']): PacketInfo {
    return {
        pid: 1,
        uin: '10001',
        serviceCmd: MSG_PUSH_CMD,
        seqId: 1,
        retCode: 0,
        fromClient: false,
        body: Buffer.from(protobuf_encode<PushMsg>({ message, status: 0 })),
    };
}

function card(sequence = 778899, senderUin = 456, app = 'com.tencent.qun.invite'): PacketInfo {
    return jsonCard(
        {
            app,
            bizsrc: 'qun.invite',
            meta: {
                news: { jumpUrl: `mqqapi://group/invite_join?groupcode=999&msgseq=${sequence}` },
            },
        },
        senderUin,
    );
}

function jsonCard(content: unknown, senderUin = 456): PacketInfo {
    const json = JSON.stringify(content);
    return packet({
        responseHead: { fromUin: senderUin, fromUid: 'u_inviter', toUin: 10001 },
        contentHead: { msgType: 166, timestamp: 1, sequence: 12, ntMsgSeq: 12, msgId: 12 },
        body: {
            richText: {
                elems: [
                    { lightApp: { data: Buffer.concat([Buffer.from([1]), deflateSync(json)]) } },
                ],
            },
        },
    });
}

function selfInviteNotice(): PacketInfo {
    return packet({
        contentHead: { msgType: 87, timestamp: 1 },
        body: {
            msgContent: protobuf_encode<GroupInvite>({ groupUin: 999, invitorUid: 'u_inviter' }),
        },
    });
}

function request(overrides: Partial<GroupRequestInfo> = {}): GroupRequestInfo {
    return {
        groupId: 999,
        groupName: 'group',
        targetUid: 'u_applicant',
        targetUin: 123,
        targetName: '',
        invitorUid: '',
        invitorUin: 0,
        invitorName: '',
        operatorUid: '',
        operatorUin: 0,
        operatorName: '',
        sequence: 42,
        state: 1,
        notifyType: 7,
        eventType: 1,
        comment: 'please',
        filtered: false,
        ...overrides,
    };
}

describe('group request events', () => {
    it.each(['com.tencent.qun.invite', 'com.tencent.tuwen.lua'])(
        'handles %s invite cards without reading either inbox',
        async (app) => {
            const { bridge, received, fetchRequests, fetchNumericRequests } = setup();
            const setAddRequest = vi
                .spyOn(bridge.apis.groupAdmin, 'setAddRequest')
                .mockResolvedValue();

            await bridge.onPacket(card(778899, 456, app));

            expect(received).toEqual([
                expect.objectContaining({
                    groupId: 999,
                    fromUin: 456,
                    fromUid: 'u_inviter',
                    invitedUin: 10001,
                    subType: 'invite',
                    flag: 'slreq:1:778899:999:2:0',
                }),
            ]);
            await handleGroupAddRequest(bridge, received[0]!.flag, true, '');
            expect(setAddRequest).toHaveBeenCalledWith(999, 778899, 2, true, '', false, undefined);
            expect(fetchRequests).not.toHaveBeenCalled();
            expect(fetchNumericRequests).not.toHaveBeenCalled();
        },
    );

    it.each(['notice first', 'card first'])(
        'emits only the card when paired with a self-invite notice: %s',
        async (order) => {
            const { bridge, received, fetchRequests } = setup();
            const packets =
                order === 'notice first'
                    ? [selfInviteNotice(), card()]
                    : [card(), selfInviteNotice()];

            for (const incoming of packets) {
                await bridge.onPacket(incoming);
            }

            await bridge.onPacket(card());
            expect(received).toHaveLength(1);
            expect(fetchRequests).not.toHaveBeenCalled();
        },
    );

    it('keeps distinct card sequences and accounts independent', async () => {
        const first = setup();
        const second = setup();
        await first.bridge.onPacket(card());
        await first.bridge.onPacket(card(778900));
        await second.bridge.onPacket(card());
        expect(first.received).toHaveLength(2);
        expect(second.received).toHaveLength(1);
    });

    it('does not report sent cards or links in unrelated JSON cards as invitations', async () => {
        const { bridge, received } = setup();
        await bridge.onPacket(card(778899, 10001));
        await bridge.onPacket(card(778899, 456, 'unrelated.app'));
        expect(received).toEqual([]);
        expect(bridge.apis.contacts.getGroupInviteCardSequence(999)).toBeUndefined();
    });

    it.each([
        { app: 'com.tencent.tuwen.lua', meta: { detail: { title: 'ordinary card' } } },
        { app: 'com.tencent.tuwen.lua', meta: { news: { jumpUrl: '' } } },
        { app: 'com.tencent.tuwen.lua', meta: { news: { jumpUrl: 'https://example.com' } } },
    ])('preserves ordinary cards as friend messages: %j', async (content) => {
        const { bridge, received, fetchRequests } = setup();
        const friendMessage = vi.fn();
        bridge.events.on('friend_message', friendMessage);
        await bridge.onPacket(jsonCard(content));
        expect(friendMessage).toHaveBeenCalledOnce();
        expect(received).toEqual([]);
        expect(fetchRequests).not.toHaveBeenCalled();
    });

    it('reports an incoming join request with an actionable flag without polling (#597)', async () => {
        vi.useFakeTimers();
        const { bridge, received, fetchRequests } = setup();
        vi.spyOn(bridge, 'sendRawPacket').mockImplementation(async (cmd) => ({
            success: true,
            gotResponse: true,
            errorCode: 0,
            errorMessage: '',
            responseData: Buffer.from(
                protobuf_encode<OidbBase<OidbSvcTrpcTcp0x10C0Response>>({
                    body: {
                        requests: cmd.endsWith('_1')
                            ? [
                                  {
                                      sequence: 42n,
                                      eventType: 1,
                                      state: 1,
                                      group: { groupUin: 999 },
                                      target: { uid: 'u_applicant', name: 'applicant' },
                                      comment: 'please',
                                  },
                              ]
                            : [],
                    },
                }),
            ),
        }));
        vi.spyOn(bridge.identity, 'resolveUin').mockResolvedValue(123);
        const setAddRequest = vi.spyOn(bridge.apis.groupAdmin, 'setAddRequest').mockResolvedValue();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchRequests).not.toHaveBeenCalled();

        await bridge.onPacket(
            packet({
                contentHead: { msgType: 84, timestamp: 1 },
                body: {
                    msgContent: protobuf_encode<GroupJoin>({
                        groupUin: 999,
                        targetUid: 'u_applicant',
                    }),
                },
            }),
        );

        expect(fetchRequests).toHaveBeenCalledTimes(2);
        expect(received).toHaveLength(1);
        const event = received[0]!;
        expect(
            await convertEvent(
                {
                    selfId: 10001,
                    imageUrlResolver: null,
                    mediaUrlResolver: null,
                    messageIdResolver: null,
                    mediaSegmentSink: null,
                },
                event,
            ),
        ).toEqual({
            time: 1,
            self_id: 10001,
            post_type: 'request',
            request_type: 'group',
            sub_type: 'add',
            group_id: 999,
            user_id: 123,
            comment: 'please',
            flag: 'slreq:1:42:999:1:0',
        });
        expect(await getGroupSystemMessages(bridge, { onlyPending: true })).toEqual([
            expect.objectContaining({
                requester_uin: 123,
                requester_nick: 'applicant',
                flag: event.flag,
            }),
        ]);
        await handleGroupAddRequest(bridge, event.flag, true, '');
        expect(setAddRequest).toHaveBeenCalledWith(999, 42, 1, true, '', false, undefined);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchRequests).toHaveBeenCalledTimes(2);
    });

    it('does not emit a fallback request or retry after an inbox failure', async () => {
        vi.useFakeTimers();
        const { bridge, received, fetchRequests } = setup();
        fetchRequests.mockRejectedValue(new Error('request lookup failed'));
        bridge.registerCmd('test.request', () => [
            {
                kind: 'group_invite',
                time: 1,
                selfUin: 10001,
                groupId: 999,
                fromUin: 123,
                fromUid: 'u_applicant',
                subType: 'add',
                message: '',
                flag: 'add:999:u_applicant',
            },
        ]);
        await bridge.onPacket({ ...selfInviteNotice(), serviceCmd: 'test.request' });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(received).toEqual([]);
        expect(fetchRequests).toHaveBeenCalledTimes(2);
    });

    it('matches only a pending request of the notified type', async () => {
        const { bridge, received, fetchRequests } = setup();
        fetchRequests.mockImplementation(async (filtered) =>
            filtered
                ? [request({ sequence: 43, filtered: true })]
                : [request({ state: 2 }), request({ eventType: 22 }), request({ groupId: 998 })],
        );
        bridge.registerCmd('test.request', () => [
            {
                kind: 'group_invite',
                time: 1,
                selfUin: 10001,
                groupId: 999,
                fromUin: 123,
                fromUid: 'u_applicant',
                subType: 'add',
                message: '',
                flag: 'add:999:u_applicant',
            },
        ]);
        await bridge.onPacket({ ...selfInviteNotice(), serviceCmd: 'test.request' });
        expect(received).toEqual([expect.objectContaining({ flag: 'slreq:1:43:999:1:1' })]);
    });

    it.each(['u_invitee', undefined])(
        'requires the notified invitee to match pending invitations: %s',
        async (invitedUid) => {
            const { bridge, received, fetchRequests } = setup();
            fetchRequests.mockImplementation(async (filtered) =>
                filtered
                    ? []
                    : [
                          request({
                              sequence: 41,
                              invitorUid: 'u_inviter',
                              invitorUin: 456,
                              targetUid: 'u_other',
                              eventType: 22,
                          }),
                          request({
                              sequence: 42,
                              invitorUid: 'u_inviter',
                              invitorUin: 456,
                              targetUid: 'u_invitee',
                              targetUin: 789,
                              eventType: 22,
                          }),
                      ],
            );
            bridge.registerCmd('test.request', () => [
                {
                    kind: 'group_invite',
                    time: 1,
                    selfUin: 10001,
                    groupId: 999,
                    fromUin: 456,
                    fromUid: 'u_inviter',
                    invitedUid,
                    subType: 'invite',
                    message: '',
                    flag: 'invite:999:u_inviter',
                },
            ]);
            await bridge.onPacket({ ...selfInviteNotice(), serviceCmd: 'test.request' });
            expect(received).toEqual(
                invitedUid
                    ? [expect.objectContaining({ invitedUin: 789, flag: 'slreq:1:42:999:22:0' })]
                    : [],
            );
        },
    );

    it('drains both inbox requests before releasing the account after a failure', async () => {
        const { bridge, received, fetchRequests } = setup();
        let finishFiltered!: (value: GroupRequestInfo[]) => void;
        const filtered = new Promise<GroupRequestInfo[]>((resolve) => {
            finishFiltered = resolve;
        });
        fetchRequests.mockImplementation((isFiltered) =>
            isFiltered ? filtered : Promise.reject(new Error('main inbox failed')),
        );
        bridge.registerCmd('test.request', () => [
            {
                kind: 'group_invite',
                time: 1,
                selfUin: 10001,
                groupId: 999,
                fromUin: 123,
                fromUid: 'u_applicant',
                subType: 'add',
                message: '',
                flag: 'add:999:u_applicant',
            },
        ]);
        const processing = bridge.onPacket({ ...selfInviteNotice(), serviceCmd: 'test.request' });
        await vi.waitFor(() => expect(fetchRequests).toHaveBeenCalledTimes(2));
        const disposed = vi.fn();
        const disposal = bridge.dispose().then(disposed);
        await Promise.resolve();
        expect(disposed).not.toHaveBeenCalled();
        finishFiltered([]);
        await Promise.all([processing, disposal]);
        expect(disposed).toHaveBeenCalledOnce();
        expect(received).toEqual([]);
    });
});
