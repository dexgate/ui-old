import alt from "../alt-instance";
import iDB from "../idb-instance";
import Immutable from "immutable";
import BaseStore from "./BaseStore";
import ChainStore from "api/ChainStore"
import PrivateKeyStore from "stores/PrivateKeyStore"
import PrivateKeyActions from "actions/PrivateKeyActions"

class AccountRefsStore extends BaseStore {
    
    constructor() {
        super()
        this._export("loadDbData", "reset")
        this.state = this._getInitialState()
        this.bindListeners({ onAddPrivateKey: PrivateKeyActions.addKey })
        ChainStore.subscribe(this.chainStoreUpdate.bind(this))
    }
    
    _getInitialState() {
        this.no_account_refs = Immutable.Set() // Set of account ids
        this.chainstore_account_ids_by_key = null
        return {
            account_refs: Immutable.Set()
            // loading_account_refs: false
        }
    }
    
    loadDbData() {
        return loadNoAccountRefs()
            .then( no_account_refs => this.no_account_refs = no_account_refs )
            .then( ()=> this.chainStoreUpdate() )
    }

    reset() {
        this.setState(this._getInitialState())
    }

    chainStoreUpdate() {
        if(this.chainstore_account_ids_by_key === ChainStore.account_ids_by_key) return
        this.chainstore_account_ids_by_key = ChainStore.account_ids_by_key
        var no_account_refs = this.no_account_refs
        var account_refs = Immutable.Set()
        PrivateKeyStore.getState().keys.keySeq().forEach( pubkey => {
            if(no_account_refs.has(pubkey)) return
            var refs = ChainStore.getAccountRefsOfKey(pubkey)
            if(refs === undefined) {
                // this.setState({loading_account_refs: true})
                return
            }
            if( ! refs.size) {
                no_account_refs = no_account_refs.add(pubkey)
                return
            }
            account_refs = account_refs.add(refs.valueSeq())
        })
        account_refs = account_refs.flatten()
        if(!this.state.account_refs.equals(account_refs))
            this.setState({account_refs})
        if(!this.no_account_refs.equals(no_account_refs)) {
            this.no_account_refs = no_account_refs
            saveNoAccountRefs(no_account_refs)
        }
        return null
    }
    
    onAddPrivateKey({private_key_object}) {
        if(ChainStore.getAccountRefsOfKey(private_key_object.pubkey) !== undefined)
            this.chainStoreUpdate()
    }
    
}
    
module.exports = alt.createStore(AccountRefsStore, "AccountRefsStore")

function loadNoAccountRefs() {
    return iDB.root.getProperty("no_account_refs", [])
        .then( array => Immutable.Set(array) )
}

function saveNoAccountRefs(no_account_refs) {
    var array = []
    for(let pubkey of no_account_refs) array.push(pubkey)
    iDB.root.setProperty("no_account_refs", array)
        .catch( error => console.error(error) )
}
