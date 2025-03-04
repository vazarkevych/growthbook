import React, { useState } from "react";
import useUser from "../../hooks/useUser";
import Tooltip from "../../components/Tooltip";
import { FaQuestionCircle } from "react-icons/fa";
import { GBEdit } from "../../components/Icons";
import EditAttributesModal from "../../components/Features/EditAttributesModal";
import { useAttributeSchema } from "../../services/features";

const FeatureAttributesPage = (): React.ReactElement => {
  const [editOpen, setEditOpen] = useState(false);
  const { permissions } = useUser();
  const attributeSchema = useAttributeSchema();

  return (
    <>
      <div className="contents container-fluid pagecontents">
        <div className="mb-5">
          <div className="row mb-3 align-items-center">
            <div className="col-auto">
              <h3>Targeting Attributes</h3>
              <p className="text-gray">
                These attributes can be used when targeting feature flags.
                Attributes set here must also be passed in through the SDK.
              </p>
            </div>
            <div style={{ flex: 1 }} />
            {permissions.organizationSettings && (
              <div className="col-auto">
                <button
                  className="btn btn-primary float-right"
                  onClick={() => {
                    setEditOpen(true);
                  }}
                >
                  <span className="h4 pr-2 m-0 d-inline-block align-top">
                    <GBEdit />
                  </span>
                  Edit Attributes
                </button>
              </div>
            )}
          </div>
          <table className="table gbtable">
            <thead>
              <tr>
                <th>Attribute</th>
                <th>Data Type</th>
                <th>
                  Identifier{" "}
                  <Tooltip text="Any attribute that uniquely identifies a user, account, device, or similar.">
                    <FaQuestionCircle
                      style={{ position: "relative", top: "-1px" }}
                    />
                  </Tooltip>
                </th>
              </tr>
            </thead>
            <tbody>
              {attributeSchema && attributeSchema.length > 0 ? (
                <>
                  {attributeSchema.map((v, i) => (
                    <tr key={i}>
                      <td className="text-gray font-weight-bold">
                        {v.property}
                      </td>
                      <td className="text-gray">
                        {v.datatype}
                        {v.datatype === "enum" && <>: ({v.enum})</>}
                      </td>
                      <td className="text-gray">
                        {v.hashAttribute && <>yes</>}
                      </td>
                    </tr>
                  ))}
                </>
              ) : (
                <>
                  <tr>
                    <td colSpan={3} className="text-center text-gray">
                      <em>
                        No attributes defined{" "}
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setEditOpen(true);
                          }}
                        >
                          Add attributes now
                        </a>
                      </em>
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {editOpen && <EditAttributesModal close={() => setEditOpen(false)} />}
    </>
  );
};

export default FeatureAttributesPage;
