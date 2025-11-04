sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment",
    "sap/ui/model/Sorter"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast, MessageBox, Fragment, Sorter) {
    "use strict";

    // --- FIX: Moved constants inside the controller definition ---
    // We can't use 'const' here, so they become part of the controller instance.
    
    return Controller.extend("timetracker.controller.View1", {

        _timerInterval: null,
        _oSubmitDialog: null,
        sUserId: null, 
        sOrderStateKey: null, 
        sDraftStorageKey: null,

        // --- FIX: Defined constants as properties ---
        ORDER_TIMER_STATE_KEY_TEMPLATE: "_timeTrackerOrderStates",
        DRAFT_STORAGE_KEY_TEMPLATE: "_timeTrackerDraftEntries",

        onInit: function () {
            this._initializeUserSession();

            var oActiveTimerModel = new JSONModel({
                activeOrderId: null,
                activeOperationId: null
            });
            this.getView().setModel(oActiveTimerModel, "activeTimer");

            var oDialogModel = new JSONModel({
                orderId: null,
                operationId: null,
                workStartDate: null,
                workFinishDate: null,
                actualWork: "0.0",
                confirmationText: "",
                isFinalConfirmation: false,
                contextPath: null
            });
            this.getView().setModel(oDialogModel, "dialog");
            
            // --- FIX 2: Added viewState model for panel visibility ---
            var oViewStateModel = new JSONModel({
                isProgressPanelVisible: false
            });
            this.getOwnerComponent().setModel(oViewStateModel, "viewState");

            var oDraftsModel = new JSONModel({ entries: [] });
            this.getOwnerComponent().setModel(oDraftsModel, "drafts");

            var oOrdersModel = this.getOwnerComponent().getModel("orders");
            oOrdersModel.dataLoaded().then(function() {
                var aOrders = oOrdersModel.getProperty("/orders");
                var oStoredStates = JSON.parse(localStorage.getItem(this.sOrderStateKey) || "{}");
                var bIsAnyTimerRunning = false;

                aOrders.forEach(function(oOrder, i) {
                    let key = oOrder.orderId + "-" + oOrder.operationId;
                    if (oStoredStates[key]) {
                        oOrder.timerState = oStoredStates[key];
                    } else {
                        oOrder.timerState = {
                            elapsedSeconds: 0,
                            baseElapsedSeconds: 0,
                            isRunning: false,
                            clockInTime: null
                        };
                    }
                    if (oOrder.timerState.isRunning === true) {
                        bIsAnyTimerRunning = true;
                    }
                });
                oOrdersModel.refresh();

                if (bIsAnyTimerRunning) {
                    this._startGlobalTimerInterval();
                }
                
                // --- FIX 2: Call the visibility update function ---
                this._updatePanelVisibility();
            }.bind(this));

            this.loadDraftsFromStorage();
        },

        // --- FIX: Use 'this.' to access the constants ---
        _initializeUserSession: function() {
            this.sUserId = "MUKESH_M"; 
            this.sOrderStateKey = this.sUserId + this.ORDER_TIMER_STATE_KEY_TEMPLATE;
            this.sDraftStorageKey = this.sUserId + this.DRAFT_STORAGE_KEY_TEMPLATE;
        },

        // --- FIX 2: Added helper function for panel visibility ---
        _updatePanelVisibility: function() {
            var oOrdersModel = this.getOwnerComponent().getModel("orders");
            var oViewStateModel = this.getOwnerComponent().getModel("viewState");
            var aOrders = oOrdersModel.getProperty("/orders");

            if (!aOrders) {
                return;
            }

            const bIsVisible = aOrders.some(order => order.timerState.isRunning === true);
            oViewStateModel.setProperty("/isProgressPanelVisible", bIsVisible);
        },
        
        _startGlobalTimerInterval: function() {
            if (this._timerInterval) {
                return; 
            }
            this._timerInterval = setInterval(function() {
                var oOrdersModel = this.getOwnerComponent().getModel("orders");
                var aOrders = oOrdersModel.getProperty("/orders");
                var bIsAnyTimerRunning = false;

                aOrders.forEach(function(oOrder, i) {
                    if (oOrder.timerState.isRunning) {
                        bIsAnyTimerRunning = true;
                        var sPath = "/orders/" + i;
                        var oTimerState = oOrder.timerState;
                        
                        var sClockInTime = oTimerState.clockInTime;
                        var iBaseSeconds = oTimerState.baseElapsedSeconds;
                        var iSessionSeconds = (new Date().getTime() - new Date(sClockInTime).getTime()) / 1000;
                        var iTotalSeconds = Math.round(iBaseSeconds + iSessionSeconds);
                        
                        oOrdersModel.setProperty(sPath + "/timerState/elapsedSeconds", iTotalSeconds);
                    }
                });

                if (!bIsAnyTimerRunning) {
                    clearInterval(this._timerInterval);
                    this._timerInterval = null;
                }
            }.bind(this), 1000);
        },

        _stopSpecificTimer: function(oContext) {
            var sPath = oContext.getPath();
            var oTimerState = oContext.getProperty("timerState");

            if (!oTimerState || !oTimerState.isRunning) {
                 return oTimerState.elapsedSeconds;
            }

            var sClockInTime = oTimerState.clockInTime;
            var iBaseSeconds = oTimerState.baseElapsedSeconds;
            var iSessionSeconds = (new Date().getTime() - new Date(sClockInTime).getTime()) / 1000;
            var iTotalSeconds = Math.round(iBaseSeconds + iSessionSeconds);

            oTimerState.elapsedSeconds = iTotalSeconds;
            oTimerState.isRunning = false;
            oTimerState.clockInTime = null;
            oTimerState.baseElapsedSeconds = iTotalSeconds;
            
            oContext.getModel().setProperty(sPath + "/timerState", oTimerState);
            this._saveOrderTimerStates();
            
            this._updatePanelVisibility(); // FIX 2
            return iTotalSeconds;
        },

        formatTime: function(iTotalSeconds) {
            if (iTotalSeconds === null || iTotalSeconds === undefined) {
                return "00:00:00";
            }
            var hours   = Math.floor(iTotalSeconds / 3600);
            var minutes = Math.floor((iTotalSeconds - (hours * 3600)) / 60);
            var seconds = iTotalSeconds - (hours * 3600) - (minutes * 60);
            if (hours   < 10) {hours   = "0"+hours;}
            if (minutes < 10) {minutes = "0"+minutes;}
            if (seconds < 10) {seconds = "0"+seconds;}
            return hours+':'+minutes+':'+seconds;
        },

        // --- UPDATED: Uses dynamic storage key ---
        loadDraftsFromStorage: function() {
            var oDraftsModel = this.getOwnerComponent().getModel("drafts");
            var sStoredEntries = localStorage.getItem(this.sDraftStorageKey); // FIX
            if (sStoredEntries) {
                oDraftsModel.setProperty("/entries", JSON.parse(sStoredEntries));
            }
        },

        // --- UPDATED: Uses dynamic storage key ---
        saveDraftsToStorage: function() {
            var oDraftsModel = this.getOwnerComponent().getModel("drafts");
            var aEntries = oDraftsModel.getProperty("/entries");
            localStorage.setItem(this.sDraftStorageKey, JSON.stringify(aEntries)); // FIX
        },

        onFilterOrders: function(oEvent) {
            var sQuery = oEvent.getParameter("newValue");
            var aFilters = [];
            if (sQuery && sQuery.length > 0) {
                 var oFilter = new Filter({
                    filters: [
                        new Filter("orderDesc", FilterOperator.Contains, sQuery),
                        new Filter("operationDesc", FilterOperator.Contains, sQuery),
                        new Filter("orderId", FilterOperator.Contains, sQuery),
                        new Filter("assignedTo", FilterOperator.Contains, sQuery)
                    ],
                    and: false
                });
                aFilters.push(oFilter);
            }
            this.byId("ordersList").getBinding("items").filter(aFilters);
            this.byId("inProgressList").getBinding("items").filter(aFilters);
        },

        onSelectOrder: function (oEvent) {
             var oContext = oEvent.getSource().getBindingContext("orders");
             var sOrderId = oContext.getProperty("orderId");
             var sOperationId = oContext.getProperty("operationId");
             var oActiveTimerModel = this.getView().getModel("activeTimer");

             var sCurrentActiveId = oActiveTimerModel.getProperty("/activeOrderId");
             var sCurrentActiveOp = oActiveTimerModel.getProperty("/activeOperationId");

             if (oContext.getProperty("timerState/isRunning")) {
                 return;
             }

             if (sCurrentActiveId === sOrderId && sCurrentActiveOp === sOperationId) {
                 oActiveTimerModel.setProperty("/activeOrderId", null);
                 oActiveTimerModel.setProperty("/activeOperationId", null);
             } else {
                 oActiveTimerModel.setProperty("/activeOrderId", sOrderId);
                 oActiveTimerModel.setProperty("/activeOperationId", sOperationId);
             }
        },

        onClockIn: function(oEvent) {
            var oContext = oEvent.getSource().getBindingContext("orders");
            
            var oTimerState = oContext.getProperty("timerState");
            oTimerState.isRunning = true;
            oTimerState.clockInTime = new Date().toISOString();
            oTimerState.baseElapsedSeconds = oTimerState.elapsedSeconds || 0;
            
            oContext.getModel().setProperty(oContext.getPath() + "/timerState", oTimerState);
            this._saveOrderTimerStates(); 
            
            this._startGlobalTimerInterval();
            this._updatePanelVisibility(); // FIX 2
        },

        onClockOut: function(oEvent) {
            var oContext = oEvent.getSource().getBindingContext("orders");
            var sClockOutTime = new Date();
            var sClockInTime = new Date(oContext.getProperty("timerState/clockInTime"));

            var iFinalElapsedSeconds = this._stopSpecificTimer(oContext);
            var fActualWorkHours = (iFinalElapsedSeconds / 3600).toFixed(2);
            
            var oDialogModel = this.getView().getModel("dialog");
            oDialogModel.setData({
                orderId: oContext.getProperty("orderId"),
                operationId: oContext.getProperty("operationId"),
                workStartDate: sClockInTime,
                workFinishDate: sClockOutTime,
                actualWork: fActualWorkHours, 
                elapsedSeconds: iFinalElapsedSeconds,
                confirmationText: "",
                isFinalConfirmation: false,
                contextPath: oContext.getPath() 
            });

            this.openSubmitDialog();
        },

        openSubmitDialog: function() {
            if (!this._oSubmitDialog) {
                Fragment.load({
                    name: "timetracker.view.fragment.SubmitDialog",
                    controller: this
                }).then(function (oDialog) {
                    this._oSubmitDialog = oDialog;
                    this.getView().addDependent(this._oSubmitDialog);
                    this._oSubmitDialog.open();
                }.bind(this));
            } else {
                this._oSubmitDialog.open();
            }
        },

        onCloseDialog: function() {
            this._oSubmitDialog.close();
        },

        onSubmitConfirmation: function() {
            var oDialogModel = this.getView().getModel("dialog");
            var oData = oDialogModel.getData();
            
            if (!oData.workStartDate || !oData.workFinishDate || !oData.actualWork) {
                MessageBox.error("Please fill in all required time fields.");
                return;
            }
            
            MessageToast.show("Submitting to S/4HANA...");
            
            var bIsPostSuccessful = Math.random() > 0.3;
            
            setTimeout(function() {
                if (bIsPostSuccessful) {
                    MessageToast.show("Confirmation for " + oData.orderId + " posted successfully!");
                    this.onCloseDialog();
                    
                    var oOrdersModel = this.getOwnerComponent().getModel("orders");
                    var aOrders = oOrdersModel.getProperty("/orders");
                    var aNewOrders = aOrders.filter(function(order) {
                        return !(order.orderId === oData.orderId && order.operationId === oData.operationId);
                    });
                    
                    oOrdersModel.setProperty("/orders", aNewOrders);
                    this._saveOrderTimerStates();

                } else {
                    MessageBox.error("Network Error: Could not submit. Entry saved to Drafts.", {
                        onClose: function() {
                            this.saveEntryToDrafts(oData, "Network Error");
                            this.onCloseDialog();
                            
                            var oOrdersModel = this.getOwnerComponent().getModel("orders");
                            oOrdersModel.setProperty(oData.contextPath + "/timerState/elapsedSeconds", 0);
                            oOrdersModel.setProperty(oData.contextPath + "/timerState/baseElapsedSeconds", 0);
                            oOrdersModel.setProperty(oData.contextPath + "/timerState/clockInTime", null);
                            this._saveOrderTimerStates();
                        }.bind(this)
                    });
                }
                this._updatePanelVisibility(); // FIX 2
            }.bind(this), 2000);
        },

        saveEntryToDrafts: function(oData, sError) {
            var oDraftsModel = this.getOwnerComponent().getModel("drafts");
            var aEntries = oDraftsModel.getProperty("/entries");
            
            var newDraftEntry = {
                id: Date.now().toString(),
                orderId: oData.orderId,
                operationId: oData.operationId,
                elapsedSeconds: oData.elapsedSeconds,
                formattedTime: this.formatTime(oData.elapsedSeconds),
                workStartDate: oData.workStartDate,
                workFinishDate: oData.workFinishDate,
                actualWork: oData.actualWork,
                confirmationText: oData.confirmationText,
                isFinalConfirmation: oData.isFinalConfirmation,
                errorText: sError
            };

            aEntries.unshift(newDraftEntry);
            oDraftsModel.refresh();
            this.saveDraftsToStorage();
        },

        onPostDraft: function(oEvent) {
            var oContext = oEvent.getSource().getBindingContext("drafts");
            var oDraft = oContext.getObject();
            
            MessageToast.show("Retrying post for Order " + oDraft.orderId + "...");
            
            setTimeout(function() {
                MessageToast.show("Draft posted successfully!");
                var oDraftsModel = this.getOwnerComponent().getModel("drafts");
                var aEntries = oDraftsModel.getProperty("/entries");
                var aNewEntries = aEntries.filter(entry => entry.id !== oDraft.id);
                oDraftsModel.setProperty("/entries", aNewEntries);
                this.saveDraftsToStorage();
            }.bind(this), 2000);
        },

        _stopCurrentlyRunningTimer: function() {
            // Optional
        },

        // --- UPDATED: Uses dynamic storage key ---
        _saveOrderTimerStates: function() {
            var aOrders = this.getOwnerComponent().getModel("orders").getProperty("/orders");
            var oStatesToSave = {};
            aOrders.forEach(function(oOrder) {
                let key = oOrder.orderId + "-" + oOrder.operationId;
                oStatesToSave[key] = oOrder.timerState;
            });
            localStorage.setItem(this.sOrderStateKey, JSON.stringify(oStatesToSave)); // FIX
        },

        onDeleteDraft: function(oEvent) {
            var oContext = oEvent.getSource().getBindingContext("drafts");
            var oDraft = oContext.getObject();
            var oDraftsModel = this.getOwnerComponent().getModel("drafts");
            var aEntries = oDraftsModel.getProperty("/entries");

            MessageBox.confirm("Are you sure you want to delete this draft entry?", {
                onClose: function(sAction) {
                    if (sAction === MessageBox.Action.OK) {
                        var aNewEntries = aEntries.filter(entry => entry.id !== oDraft.id);
                        oDraftsModel.setProperty("/entries", aNewEntries);
                        this.saveDraftsToStorage();
                        MessageToast.show("Draft deleted.");
                    }
                }.bind(this)
            });
        }
    });
});

