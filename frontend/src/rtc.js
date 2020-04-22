const Config = {
    iceServers:[
        {url: 'stun:stun.l.google.com:19302'},
        {url: 'stun:stun.ekiga.net'},
        {url: 'stun:stun.voxgratia.org'},
        {url: 'stun:23.21.150.121'},
    ]
};

const OfferOptions = {
    offerToReceiveAudio: 1,
    offerToReceiveVideo: 1
};

const AnswerOptions = {
    offerToReceiveAudio: 0,
    offerToReceiveVideo: 0,
};


export default class WebRTC {
    constructor() {
        this.peerConnection = new RTCPeerConnection(Config);
    }

    addStream(stream) {
        stream.getTracks().forEach(track => this.peerConnection.addTrack(track, stream));
    }

    async createOffer(callback) {
        this.peerConnection.onicecandidate = async (candidate) => {
            await callback(this.peerConnection.localDescription, candidate)
        };
        const offer = await this.peerConnection.createOffer(OfferOptions);
        await this.peerConnection.setLocalDescription(offer);
    }

    async createAnswer(offer, callback) {
        await this.peerConnection.setRemoteDescription(offer);
        this.peerConnection.onicecandidate = async (candidate) => {
            await callback(this.peerConnection.localDescription, candidate)
        };
        const answer = await this.peerConnection.createAnswer(AnswerOptions);
        await this.peerConnection.setLocalDescription(answer);
    }

    async onAnswer(answer) {
        await this.peerConnection.setRemoteDescription(answer);
    }

    addOnTrackListener(callback) {
        this.peerConnection.addEventListener('track', callback);
    }

    close() {
        this.peerConnection.close();
    }
}
