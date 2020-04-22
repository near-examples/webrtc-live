import "./App.css";
import React from 'react';
import * as nearlib from 'nearlib';
import * as nacl from "tweetnacl";
import WebRTC from './rtc.js';
import { Profile } from 'metanear-react-components';
import Cat from './cat.jpg';

const ContractName = 'webrtc-live';
const StreamKey = 's';

const MediaConstraints = {
  audio: true,
  video: true
};

class App extends React.Component {
  constructor(props) {
    super(props);

    this._parseEncryptionKey()

    this.state = {
      connected: false,
      signedIn: false,
      videoIsOn: false,
      streaming: false,
      accountId: null,
      connectingToRemote: false,
      streamingFrom: null,
      streamUrl: this._streamUrl,
      viewers: [],
      live: false,
      muted: true,
    };

    this.playing = false;
    this._urlParsed = false;

    this._initNear().then(() => {
      this.setState({
        connected: true,
        signedIn: !!this._accountId,
        accountId: this._accountId,
      })
      if (this._mounted && this.state.signedIn) {
        this._parseUrl();
      }
    })

    this._checkForAnswersTimeout = false;
    this._alreadyPublishedAnswer = false;

    this.videoRef = React.createRef();
    this.streamUrlRef = React.createRef();
    this.oldWebrtcs = []

    window.onbeforeunload = () => (this.state.streaming && !this.state.streamingFrom) || undefined;
  }

  /**
   read private key from local storage
   - if found, recreate the related key pair
   - if not found, create a new key pair and save it to local storage
   */
  _parseEncryptionKey() {
    const keyKey = "enc_key:";
    let key = localStorage.getItem(keyKey);
    if (key) {
      const buf = Buffer.from(key, 'base64');
      if (buf.length !== nacl.box.secretKeyLength) {
        throw new Error("Given secret key has wrong length");
      }
      key = nacl.box.keyPair.fromSecretKey(buf);
    } else {
      key = new nacl.box.keyPair();
      localStorage.setItem(keyKey, Buffer.from(key.secretKey).toString('base64'));
    }
    this._key = key;
    this._streamKey = Buffer.from(this._key.publicKey).toString('base64');
    this._secretKey = Buffer.from(this._key.secretKey).toString('base64');
    const url = new URL(document.location.pathname, document.location.href);
    url.searchParams.append(StreamKey, this._secretKey);
    this._streamUrl = url.toString();
  }

  async _parseUrl() {
    if (this._urlParsed) {
      return;
    }
    this._urlParsed = true;
    let p = new URLSearchParams(document.location.search);
    let key = p.get(StreamKey);
    if (!key) {
      return;
    }
    const buf = Buffer.from(key, 'base64');
    if (buf.length !== nacl.box.secretKeyLength) {
      throw new Error("Given secret key has wrong length");
    }
    this._remoteKey = nacl.box.keyPair.fromSecretKey(buf);
    this._remoteStreamKey = Buffer.from(this._remoteKey.publicKey).toString('base64');
    const info = await this._contract.get({
      key: this._remoteStreamKey,
    });
    if (info.offer) {
      console.log(info)
      this.setState({
        streamingFrom: info.owner_id,
      })
      this._offer = info.offer;
      const remoteStream = JSON.parse(this.decryptSecretBox(info.offer, this._remoteKey));
      await this.connectToStream(remoteStream);
    }
  }

  componentDidMount() {
    this._mounted = true;
    if (this.state.signedIn) {
      this._parseUrl();
    }
  }

  async connectToStream(offer) {
    this.badOffer = false;
    this.playing = false;
    this.setState({
      connectingToRemote: true,
    });
    this.webrtc = new WebRTC();
    this.webrtc.addOnTrackListener((e) => {
      console.log("got remote streams", e);
      if (this.videoRef.current.srcObject !== e.streams[0]) {
        this._stream = e.streams[0];
        this.videoRef.current.srcObject = e.streams[0];
        this.videoRef.current.play();
     }
    });

    this.videoRef.current.onplaying = async () => {
      console.log("Playing");
      this.playing = true;
      this.videoRef.current.onplaying = undefined;
      if (this.badOffer) {
        this.videoRef.current.pause();
      } else {
        await this.startStream(true);
      }
    };

    await this.webrtc.createAnswer(offer, async (answer, c) => {
      // console.log("On answer", offer, c);
      this._lastAnswer = answer;
      await this.publishAnswer(answer);
    })
    this.setState({
      receivingStream: true,
    })
  }

  stopAnswering() {
    this._publishingAnswerInProgress = false;
    this.webrtc.close();
    this.webrtc = null;
    this.badOffer = true;
    this.setState({
      streamingFrom: false,
    })
  }

  async publishAnswer(answer) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (this._publishingAnswerInProgress || answer !== this._lastAnswer || this.badOffer || this.playing) {
      return;
    }
    this._publishingAnswerInProgress = true;
    let info = await this._contract.get({
      key: this._remoteStreamKey,
    });
    if (info.answer) {
      if (info.answer.account_id !== this.state.accountId || info.offer !== this._offer || !this._alreadyPublishedAnswer) {
        console.log("Bad offer");
        this.stopAnswering();
        return;
      }
    }
    console.log("Publishing answer", answer);
    let published = false;
    try {
      await this._contract.answer({
        key: this._remoteStreamKey,
        stream: this.encryptSecretBox(JSON.stringify(answer), this._remoteKey),
        offer: this._offer,
        is_new: !this._alreadyPublishedAnswer,
        restream_key: this.encryptSecretBox(this._secretKey, this._remoteKey),
      });
      published = true;
    } catch (e) {
      console.log("Failed to publish answer", e);
      if (!this.playing && e.toString().indexOf("Smart contract panicked") >= 0) {
        this.stopAnswering();
      }
    }
    this._publishingAnswerInProgress = false;
    if (!this.playing && (!published || this._lastAnswer !== answer)) {
      await this.publishAnswer(this._lastAnswer);
    }
  }


  async _initNear() {
    const nearConfig = {
      networkId: 'default',
      nodeUrl: 'https://rpc.nearprotocol.com',
      contractName: ContractName,
      walletUrl: 'https://wallet.nearprotocol.com',
    };
    const keyStore = new nearlib.keyStores.BrowserLocalStorageKeyStore();
    const near = await nearlib.connect(Object.assign({ deps: { keyStore } }, nearConfig));
    this._keyStore = keyStore;
    this._nearConfig = nearConfig;
    this._near = near;

    this._walletConnection = new nearlib.WalletConnection(near, "webrtc-live");
    this._accountId = this._walletConnection.getAccountId();

    this._account = this._walletConnection.account();
    this._contract = new nearlib.Contract(this._account, ContractName, {
      viewMethods: ['get'],
      changeMethods: ['offer', 'answer', 'take_answer'],
    });
  }

  handleChange(key, value) {
    const stateChange = {
      [key]: value,
    };
    this.setState(stateChange);
  }

  async requestSignIn() {
    const appTitle = 'WebRTC Live Streaming';
    await this._walletConnection.requestSignIn(
        ContractName,
        appTitle
    )
  }

  /**
   unbox encrypted messages with our secret key
   @param {string} msg64 encrypted message encoded as Base64
   @return {string} decoded contents of the box
   */
  decryptSecretBox(msg64, key) {
    const buf = Buffer.from(msg64, 'base64');
    const nonce = new Uint8Array(nacl.secretbox.nonceLength);
    buf.copy(nonce, 0, 0, nonce.length);
    const box = new Uint8Array(buf.length - nacl.secretbox.nonceLength);
    buf.copy(box, 0, nonce.length);
    const decodedBuf = nacl.secretbox.open(box, nonce, key.secretKey);
    return Buffer.from(decodedBuf).toString()
  }

  /**
   box an unencrypted message with our secret key
   @param {string} str the message to wrap in a box
   @return {string} base64 encoded box of incoming message
   */
  encryptSecretBox(str, key) {
    const buf = Buffer.from(str);
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const box = nacl.secretbox(buf, nonce, key.secretKey);

    const fullBuf = new Uint8Array(box.length + nacl.secretbox.nonceLength);
    fullBuf.set(nonce);
    fullBuf.set(box, nacl.secretbox.nonceLength);
    return Buffer.from(fullBuf).toString('base64')
  }

  async publishOffer(offer, isNew) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (this._publishingInProgress || offer !== this._lastOffer || !this.state.streaming) {
      return;
    }
    let published = false;
    this._publishingInProgress = true;
    console.log("Publishing offer", offer);
    try {
      await this._contract.offer({
        key: this._streamKey,
        offer: this.encryptSecretBox(JSON.stringify(offer), this._key),
        is_new: isNew
      });
      published = true;
    } catch(e) {
      console.log("Failed to publish offer", e)
    }
    this._publishingInProgress = false;
    if (!published || this._lastOffer !== offer) {
      await this.publishOffer(this._lastOffer, isNew);
    } else {
      this.setState({
        live: true,
      })
      await this.checkForAnswers();
    }
  }

  async checkForAnswers() {
    if (this._checkForAnswersTimeout) {
      clearTimeout(this._checkForAnswersTimeout);
      this._checkForAnswersTimeout = null;
    }

    if (!this.state.streaming) {
      return;
    }

    let tookAnswer = false;
    let answer = null;
    let addedViewer = false;
    let oldViewers = false;
    try {
      let info = await this._contract.get({ key: this._streamKey });
      if (info.answer) {
        answer = info.answer;
        console.log("Got answer", answer);
        oldViewers = this.state.viewers;
        this.setState({
          viewers: this.state.viewers.concat(answer.account_id),
        });
        addedViewer = true;
        const encryptedStream = answer.stream;
        if (encryptedStream) {
          const remoteStream = JSON.parse(this.decryptSecretBox(encryptedStream, this._key));
          await this.webrtc.onAnswer(remoteStream);
        }
        await this._contract.take_answer({ key: this._streamKey, answer });
        tookAnswer = true;
      }
    } catch (e) {
      console.log("Failed to get the answer", e);
    }

    if (tookAnswer) {
      await this.startStream(false);
    } else {
      this._checkForAnswersTimeout = setTimeout(() => this.checkForAnswers(), 1000);
      if (addedViewer) {
        this.setState({
          viewers: oldViewers,
        });
      }
    }
  }

  async startStream(isNew) {
    if (this.webrtc) {
      this.oldWebrtcs.push(this.webrtc);
    }
    this.webrtc = new WebRTC();
    this.webrtc.addStream(this._stream);
    this.setState({
      streaming: true,
    })
    await this.webrtc.createOffer(async (offer, c) => {
      // console.log("On offer", offer, c);
      this._lastOffer = offer;
      await this.publishOffer(offer, isNew);
    })
  }

  stopStream() {
    if (this.state.streaming) {
      this.webrtc && this.webrtc.close();
      this.webrtc = null;
      this.oldWebrtcs.forEach((w) => w.close());
      this.oldWebrtcs = [];
      this.setState({
        streaming: false,
      })
      this._contract.offer({
        key: this._streamKey,
        offer: null,
        is_new: true
      });
    }
  }

  stopVideo() {
    if (this.state.videoIsOn) {
      this.videoRef.current.pause();
      this.setState({
        videoIsOn: false,
      })
    }
  }

  async initVideo() {
    const stream = await navigator.mediaDevices.getUserMedia(MediaConstraints);
    this.videoRef.current.srcObject = stream;
    this.videoRef.current.play();
    this._stream = stream;

    this.setState({
      videoIsOn: true,
    })
  }

  async logOut() {
    this._walletConnection.signOut();
    this._accountId = null;
    this.setState({
      signedIn: !!this._accountId,
      accountId: this._accountId,
    })
  }

  toggleMute() {
    this.videoRef.current.muted = !this.videoRef.current.muted;
    this.setState({
      muted: this.videoRef.current.muted
    })
  }

  render() {
    const content = !this.state.connected ? (
        <div>Connecting... <span className="spinner-grow spinner-grow-sm" role="status" aria-hidden="true"></span></div>
    ) : (this.state.signedIn ? (
        <div>
          Hi, <Profile accountId={this.state.accountId} forceShow={true} defaultProfileUrl={Cat}/>
          <div className="float-right">
            <button
                className="btn btn-outline-secondary"
                onClick={() => this.logOut()}>Log out</button>
          </div>
          {
            this.state.streamingFrom ? (
              <div style={{margin: "1em 0"}}>
                {this.playing ? "Streaming" : "Loading stream"} from <Profile accountId={this.state.streamingFrom} forceShow={true} defaultProfileUrl={Cat}/>
                {this.playing && <button
                  className="btn btn-primary"
                  style={{marginLeft: "1em"}}
                  disabled={!this.playing}
                  onClick={() => this.toggleMute()}>
                  {this.state.muted ? "Unmute" : "Mute"}
                </button>}
              </div>
            ) : (
                <div className="form-group" style={{marginTop: "1em"}}>
                  <div>
                    <button
                        className="btn btn-success"
                        disabled={this.state.videoIsOn || this.state.streamingFrom}
                        onClick={() => this.initVideo()}>Initiate Local Video
                    </button>
                    <span> </span>
                    <button
                        className="btn btn-primary"
                        disabled={!this.state.videoIsOn || this.state.streamingFrom || this.state.streaming}
                        onClick={() => this.startStream(true)}>Start streaming
                    </button>
                    <span> </span>
                    <button
                        className="btn btn-danger"
                        disabled={!this.state.videoIsOn || this.state.streamingFrom || !this.state.streaming}
                        onClick={() => this.stopStream()}>Stop streaming
                    </button>
                    <span> </span>
                    <button
                        className="btn btn-danger"
                        disabled={!this.state.videoIsOn || this.state.streamingFrom || this.state.streaming}
                        onClick={() => this.stopVideo()}>Stop video
                    </button>
                  </div>
                </div>
            )
          }
          <video className="local-video" ref={this.videoRef} playsInline muted></video>
          <div className="form-group">
            <div className="input-group">
              <div className="input-group-prepend">
                <div className="input-group-text">Stream URL:</div>
              </div>
              <input type="text"
                     className="form-control from-large"
                     id="streamUrl"
                     ref={this.streamUrlRef}
                     // disabled={true}
                     value={this.state.streamUrl}
                     readOnly
                     onClick={() => {
                       this.streamUrlRef.current.focus();
                       this.streamUrlRef.current.select();
                     }}
              />
            </div>
          </div>
          {
            this.state.live && (
              <div>
                <h4><span role="img" aria-label="red dot">🔴</span> {this.state.streamingFrom ? "Restreaming!" : "We're live!"} List of Viewers</h4>
                {
                  this.state.viewers.map((accountId, i) => {
                    return (
                      <div key={'viewer-profile-' + accountId + ',' + i} >
                        <Profile accountId={accountId} forceShow={true} defaultProfileUrl={Cat}/>
                      </div>
                    )
                  })
                }
              </div>
            )
          }
          </div>
    ) : (
        <div>
          <button
              className="btn btn-primary"
              onClick={() => this.requestSignIn()}>Log in with NEAR Wallet</button>
        </div>
    ));
    return (
        <div>
          <h1>WebRTC Chat</h1>
          {content}
        </div>
    );
  }
}

export default App;
